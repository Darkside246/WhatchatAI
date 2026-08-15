import type { Queryable } from './types.js';
import type { GroupMemberRole } from '../domain/whatsapp/types.js';

export interface WhatsAppGroupMemberRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  groupId: string;
  participantJid: string;
  participantPhoneNumber: string | null;
  participantContactId: string | null;
  role: GroupMemberRole;
  isAdmin: boolean;
  isSuperAdmin: boolean | null;
  joinedAt: string | null;
  leftAt: string | null;
}

interface GroupMemberRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  group_id: string;
  participant_jid: string;
  participant_phone_number: string | null;
  participant_contact_id: string | null;
  role: GroupMemberRole;
  is_admin: boolean;
  is_super_admin: boolean | null;
  joined_at: string | null;
  left_at: string | null;
}

function toRecord(row: GroupMemberRow): WhatsAppGroupMemberRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    groupId: row.group_id,
    participantJid: row.participant_jid,
    participantPhoneNumber: row.participant_phone_number,
    participantContactId: row.participant_contact_id,
    role: row.role,
    isAdmin: row.is_admin,
    isSuperAdmin: row.is_super_admin,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
  };
}

export interface UpsertGroupMemberInput {
  businessId: string;
  whatsappAccountId: string;
  groupId: string;
  participantJid: string;
  participantPhoneNumber?: string | null;
  participantContactId?: string | null;
  role?: GroupMemberRole;
  isAdmin?: boolean;
  isSuperAdmin?: boolean | null;
}

export class WhatsAppGroupMemberRepository {
  constructor(private readonly db: Queryable) {}

  async upsertMember(input: UpsertGroupMemberInput): Promise<WhatsAppGroupMemberRecord> {
    const { rows } = await this.db.query<GroupMemberRow>(
      `INSERT INTO whatsapp_group_members
         (business_id, whatsapp_account_id, group_id, participant_jid,
          participant_phone_number, participant_contact_id, role, is_admin, is_super_admin, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (group_id, participant_jid)
       DO UPDATE SET
         participant_phone_number = COALESCE(EXCLUDED.participant_phone_number, whatsapp_group_members.participant_phone_number),
         participant_contact_id = COALESCE(EXCLUDED.participant_contact_id, whatsapp_group_members.participant_contact_id),
         role = EXCLUDED.role,
         is_admin = EXCLUDED.is_admin,
         is_super_admin = COALESCE(EXCLUDED.is_super_admin, whatsapp_group_members.is_super_admin),
         left_at = NULL,
         updated_at = now()
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.groupId,
        input.participantJid,
        input.participantPhoneNumber ?? null,
        input.participantContactId ?? null,
        input.role ?? 'member',
        input.isAdmin ?? false,
        input.isSuperAdmin ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_group_members upsert returned no row');
    return toRecord(row);
  }

  async markLeft(groupId: string, participantJid: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_group_members SET left_at = now(), updated_at = now()
       WHERE group_id = $1 AND participant_jid = $2`,
      [groupId, participantJid],
    );
  }

  async listByGroup(groupId: string): Promise<WhatsAppGroupMemberRecord[]> {
    const { rows } = await this.db.query<GroupMemberRow>(
      'SELECT * FROM whatsapp_group_members WHERE group_id = $1 ORDER BY joined_at NULLS LAST',
      [groupId],
    );
    return rows.map(toRecord);
  }
}
