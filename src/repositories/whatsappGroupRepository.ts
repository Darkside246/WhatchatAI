import type { Queryable } from './types.js';

export interface WhatsAppGroupRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  groupJid: string;
  name: string;
  subject: string;
  description: string | null;
  ownerJid: string | null;
  participantsCount: number;
  isCommunity: boolean | null;
  isAnnouncement: boolean | null;
  isRestricted: boolean | null;
  profilePictureUrl: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface GroupRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  group_jid: string;
  name: string;
  subject: string;
  description: string | null;
  owner_jid: string | null;
  participants_count: number;
  is_community: boolean | null;
  is_announcement: boolean | null;
  is_restricted: boolean | null;
  profile_picture_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: GroupRow): WhatsAppGroupRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    groupJid: row.group_jid,
    name: row.name,
    subject: row.subject,
    description: row.description,
    ownerJid: row.owner_jid,
    participantsCount: row.participants_count,
    isCommunity: row.is_community,
    isAnnouncement: row.is_announcement,
    isRestricted: row.is_restricted,
    profilePictureUrl: row.profile_picture_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface UpsertGroupInput {
  businessId: string;
  whatsappAccountId: string;
  groupJid: string;
  subject: string;
  description?: string | null;
  ownerJid?: string | null;
  participantsCount?: number;
  isCommunity?: boolean | null;
  isAnnouncement?: boolean | null;
  isRestricted?: boolean | null;
}

export class WhatsAppGroupRepository {
  constructor(private readonly db: Queryable) {}

  async upsertFromWhatsApp(input: UpsertGroupInput): Promise<WhatsAppGroupRecord> {
    const { rows } = await this.db.query<GroupRow>(
      `INSERT INTO whatsapp_groups
         (business_id, whatsapp_account_id, group_jid, name, subject, description,
          owner_jid, participants_count, is_community, is_announcement, is_restricted)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (business_id, whatsapp_account_id, group_jid) WHERE deleted_at IS NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         subject = EXCLUDED.subject,
         description = COALESCE(EXCLUDED.description, whatsapp_groups.description),
         owner_jid = COALESCE(EXCLUDED.owner_jid, whatsapp_groups.owner_jid),
         participants_count = EXCLUDED.participants_count,
         is_community = COALESCE(EXCLUDED.is_community, whatsapp_groups.is_community),
         is_announcement = COALESCE(EXCLUDED.is_announcement, whatsapp_groups.is_announcement),
         is_restricted = COALESCE(EXCLUDED.is_restricted, whatsapp_groups.is_restricted),
         updated_at = now()
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.groupJid,
        input.subject,
        input.description ?? null,
        input.ownerJid ?? null,
        input.participantsCount ?? 0,
        input.isCommunity ?? null,
        input.isAnnouncement ?? null,
        input.isRestricted ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_groups upsert returned no row');
    return toRecord(row);
  }

  async findByJid(businessId: string, whatsappAccountId: string, groupJid: string): Promise<WhatsAppGroupRecord | null> {
    const { rows } = await this.db.query<GroupRow>(
      `SELECT * FROM whatsapp_groups
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND group_jid = $3 AND deleted_at IS NULL`,
      [businessId, whatsappAccountId, groupJid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<WhatsAppGroupRecord | null> {
    const { rows } = await this.db.query<GroupRow>('SELECT * FROM whatsapp_groups WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Reconciliation read: groups WhatsApp reported as having participants, with zero actual member rows persisted. Report-only - member data isn't re-derivable without a fresh groups.upsert/groupMetadata call. */
  async countMissingMembers(businessId: string, whatsappAccountId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM whatsapp_groups g
       WHERE g.business_id = $1 AND g.whatsapp_account_id = $2 AND g.deleted_at IS NULL
         AND g.participants_count > 0
         AND NOT EXISTS (SELECT 1 FROM whatsapp_group_members m WHERE m.group_id = g.id)`,
      [businessId, whatsappAccountId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
