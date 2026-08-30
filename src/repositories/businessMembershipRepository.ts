import type { Queryable } from './types.js';
import type { BusinessRole } from '../domain/auth/permissions.js';

export interface BusinessMembershipRecord {
  id: string;
  businessId: string;
  userId: string;
  role: BusinessRole;
  status: 'active' | 'suspended';
  invitedBy: string | null;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipWithUser extends BusinessMembershipRecord {
  email: string;
  displayName: string;
}

interface MembershipRow {
  id: string;
  business_id: string;
  user_id: string;
  role: BusinessRole;
  status: BusinessMembershipRecord['status'];
  invited_by: string | null;
  joined_at: string;
  created_at: string;
  updated_at: string;
}

interface MembershipWithUserRow extends MembershipRow {
  email: string;
  display_name: string;
}

function toRecord(row: MembershipRow): BusinessMembershipRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRecordWithUser(row: MembershipWithUserRow): MembershipWithUser {
  return { ...toRecord(row), email: row.email, displayName: row.display_name };
}

export class BusinessMembershipRepository {
  constructor(private readonly db: Queryable) {}

  async create(businessId: string, userId: string, role: BusinessRole, invitedBy: string | null = null): Promise<BusinessMembershipRecord> {
    const { rows } = await this.db.query<MembershipRow>(
      `INSERT INTO business_memberships (business_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [businessId, userId, role, invitedBy],
    );
    const row = rows[0];
    if (!row) throw new Error('business_memberships insert returned no row');
    return toRecord(row);
  }

  async countForBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM business_memberships WHERE business_id = $1',
      [businessId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  /** A user's first active membership - the single business they land in on login, in this single-tenant-per-process runtime. */
  async findFirstActiveForUser(userId: string): Promise<BusinessMembershipRecord | null> {
    const { rows } = await this.db.query<MembershipRow>(
      `SELECT * FROM business_memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
      [userId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByUserAndBusiness(userId: string, businessId: string): Promise<BusinessMembershipRecord | null> {
    const { rows } = await this.db.query<MembershipRow>(
      'SELECT * FROM business_memberships WHERE user_id = $1 AND business_id = $2',
      [userId, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<BusinessMembershipRecord | null> {
    const { rows } = await this.db.query<MembershipRow>('SELECT * FROM business_memberships WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Tenant-scoped lookup - a membership id belonging to another business
   * returns null, identically to a genuinely nonexistent id. Prefer this
   * over the bare findById() for any caller that has a businessId in scope.
   */
  async findByIdForBusiness(id: string, businessId: string): Promise<BusinessMembershipRecord | null> {
    const { rows } = await this.db.query<MembershipRow>(
      'SELECT * FROM business_memberships WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<MembershipWithUser[]> {
    const { rows } = await this.db.query<MembershipWithUserRow>(
      `SELECT bm.*, u.email, u.display_name
       FROM business_memberships bm
       JOIN users u ON u.id = bm.user_id
       WHERE bm.business_id = $1
       ORDER BY bm.created_at`,
      [businessId],
    );
    return rows.map(toRecordWithUser);
  }

  async updateRole(id: string, role: BusinessRole): Promise<BusinessMembershipRecord | null> {
    const { rows } = await this.db.query<MembershipRow>(
      `UPDATE business_memberships SET role = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, role],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM business_memberships WHERE id = $1', [id]);
  }

  /** Immediate effect of requesting account deletion (accountDeletionService.ts) - membership rows are kept, not removed, so cancelling deletion within the grace period is a simple status flip back. */
  async suspendAllForBusiness(businessId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE business_memberships SET status = 'suspended', updated_at = now() WHERE business_id = $1 AND status = 'active'`,
      [businessId],
    );
    return rowCount ?? 0;
  }

  async reactivateAllForBusiness(businessId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE business_memberships SET status = 'active', updated_at = now() WHERE business_id = $1 AND status = 'suspended'`,
      [businessId],
    );
    return rowCount ?? 0;
  }
}
