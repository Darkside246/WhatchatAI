import type { Queryable } from './types.js';

export interface ListRecord {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ListRow {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: ListRow): ListRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface CreateListInput {
  businessId: string;
  name: string;
  description?: string | null | undefined;
  color?: string | null | undefined;
}

export interface UpdateListInput {
  name?: string | undefined;
  description?: string | null | undefined;
  color?: string | null | undefined;
}

/**
 * AURA Lists (Phase 1): the organisational unit itself. Membership and
 * agent assignment live in their own tables (listMemberRepository.ts,
 * listAgentAssignmentRepository.ts) - this repository only owns the List's
 * own identity (name/description/color), mirroring aiAgentRepository.ts's
 * own CRUD shape. RLS'd (migration 997) - always construct with
 * queryAsTenant(businessId).
 */
export class ListRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateListInput): Promise<ListRecord> {
    const { rows } = await this.db.query<ListRow>(
      `INSERT INTO lists (business_id, name, description, color) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.businessId, input.name, input.description ?? null, input.color ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('lists insert returned no row');
    return toRecord(row);
  }

  async findByIdForBusiness(id: string, businessId: string): Promise<ListRecord | null> {
    const { rows } = await this.db.query<ListRow>(
      `SELECT * FROM lists WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByBusiness(businessId: string): Promise<ListRecord[]> {
    const { rows } = await this.db.query<ListRow>(
      `SELECT * FROM lists WHERE business_id = $1 AND deleted_at IS NULL ORDER BY name ASC`,
      [businessId],
    );
    return rows.map(toRecord);
  }

  async update(id: string, businessId: string, patch: UpdateListInput): Promise<ListRecord | null> {
    const { rows } = await this.db.query<ListRow>(
      `UPDATE lists SET
         name = COALESCE($3, name),
         description = CASE WHEN $4 THEN $5 ELSE description END,
         color = CASE WHEN $6 THEN $7 ELSE color END,
         updated_at = now()
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [
        id, businessId, patch.name ?? null,
        patch.description !== undefined, patch.description ?? null,
        patch.color !== undefined, patch.color ?? null,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Soft delete, matching whatsapp_chats/crm_contacts' own convention - list_members/list_agent_assignments rows are left for a real ON DELETE CASCADE only if the row is ever hard-deleted, which nothing in this codebase does today. */
  async softDelete(id: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE lists SET deleted_at = now(), updated_at = now() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [id, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
