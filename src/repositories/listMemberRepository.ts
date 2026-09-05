import type { Queryable } from './types.js';
import type { ListRecord } from './listRepository.js';

export type ListMemberType = 'chat' | 'contact' | 'group';

export interface ListMemberRecord {
  id: string;
  businessId: string;
  listId: string;
  memberType: ListMemberType;
  chatId: string | null;
  contactId: string | null;
  groupId: string | null;
  createdAt: string;
}

interface ListMemberRow {
  id: string;
  business_id: string;
  list_id: string;
  member_type: ListMemberType;
  chat_id: string | null;
  contact_id: string | null;
  group_id: string | null;
  created_at: string;
}

function toRecord(row: ListMemberRow): ListMemberRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    listId: row.list_id,
    memberType: row.member_type,
    chatId: row.chat_id,
    contactId: row.contact_id,
    groupId: row.group_id,
    createdAt: row.created_at,
  };
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

function toListRecord(row: ListRow): ListRecord {
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

export interface AddListMemberInput {
  businessId: string;
  listId: string;
  memberType: ListMemberType;
  memberId: string;
}

/**
 * AURA Lists (Phase 1): membership is many-to-many by design - a contact
 * can belong to several Lists at once (the directive's own explicit
 * example). RLS'd (migration 997) - always construct with
 * queryAsTenant(businessId).
 */
export class ListMemberRepository {
  constructor(private readonly db: Queryable) {}

  async addMember(input: AddListMemberInput): Promise<ListMemberRecord> {
    const chatId = input.memberType === 'chat' ? input.memberId : null;
    const contactId = input.memberType === 'contact' ? input.memberId : null;
    const groupId = input.memberType === 'group' ? input.memberId : null;
    const { rows } = await this.db.query<ListMemberRow>(
      `INSERT INTO list_members (business_id, list_id, member_type, chat_id, contact_id, group_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (list_id, member_type, chat_id, contact_id, group_id) DO NOTHING
       RETURNING *`,
      [input.businessId, input.listId, input.memberType, chatId, contactId, groupId],
    );
    if (rows[0]) return toRecord(rows[0]);
    const { rows: existing } = await this.db.query<ListMemberRow>(
      `SELECT * FROM list_members WHERE list_id = $1 AND member_type = $2
         AND chat_id IS NOT DISTINCT FROM $3 AND contact_id IS NOT DISTINCT FROM $4 AND group_id IS NOT DISTINCT FROM $5`,
      [input.listId, input.memberType, chatId, contactId, groupId],
    );
    const row = existing[0];
    if (!row) throw new Error('list_members insert returned no row and none found on conflict');
    return toRecord(row);
  }

  async removeMember(businessId: string, memberId: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM list_members WHERE id = $1 AND business_id = $2`, [memberId, businessId]);
    return (result.rowCount ?? 0) > 0;
  }

  async listMembersForList(businessId: string, listId: string): Promise<ListMemberRecord[]> {
    const { rows } = await this.db.query<ListMemberRow>(
      `SELECT * FROM list_members WHERE business_id = $1 AND list_id = $2 ORDER BY created_at ASC`,
      [businessId, listId],
    );
    return rows.map(toRecord);
  }

  /**
   * The routing/isolation resolution query: every List a given chat
   * belongs to, across all three membership paths (direct chat membership,
   * contact membership via whatsapp_chats.contact_id, group membership via
   * whatsapp_chats.group_id). Returns [] when nothing matches - never
   * throws, never guesses. This is what listRoutingService.ts and
   * aiContextGathererService.ts both call to find which List(s) apply.
   */
  async resolveListsForChat(businessId: string, chatId: string): Promise<ListRecord[]> {
    const { rows } = await this.db.query<ListRow>(
      `SELECT DISTINCT l.* FROM lists l
       JOIN list_members lm ON lm.list_id = l.id
       JOIN whatsapp_chats c ON c.id = $2
       WHERE l.business_id = $1 AND l.deleted_at IS NULL AND (
         (lm.member_type = 'chat'    AND lm.chat_id = c.id) OR
         (lm.member_type = 'contact' AND lm.contact_id = c.contact_id) OR
         (lm.member_type = 'group'   AND lm.group_id = c.group_id)
       )
       ORDER BY l.name ASC`,
      [businessId, chatId],
    );
    return rows.map(toListRecord);
  }

  /**
   * Batched counterpart to resolveListsForChat - one query for every chat
   * in a page of the chat list (workspaceService.listChats), instead of
   * N+1 per-chat lookups. Returns a chatId -> listId[] map; a chat with no
   * matching row is simply absent from the map (never a fabricated []
   * entry that would make "no memberships" indistinguishable from "not
   * looked up").
   */
  async resolveListsForChats(businessId: string, chatIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (chatIds.length === 0) return result;
    const { rows } = await this.db.query<{ chat_id: string; list_id: string }>(
      `SELECT DISTINCT c.id AS chat_id, l.id AS list_id FROM lists l
       JOIN list_members lm ON lm.list_id = l.id
       JOIN whatsapp_chats c ON c.id = ANY($2)
       WHERE l.business_id = $1 AND l.deleted_at IS NULL AND (
         (lm.member_type = 'chat'    AND lm.chat_id = c.id) OR
         (lm.member_type = 'contact' AND lm.contact_id = c.contact_id) OR
         (lm.member_type = 'group'   AND lm.group_id = c.group_id)
       )`,
      [businessId, chatIds],
    );
    for (const row of rows) {
      const existing = result.get(row.chat_id);
      if (existing) existing.push(row.list_id);
      else result.set(row.chat_id, [row.list_id]);
    }
    return result;
  }
}
