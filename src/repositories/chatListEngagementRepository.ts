import type { Queryable } from './types.js';

export interface ChatListEngagementRecord {
  id: string;
  businessId: string;
  chatId: string;
  listId: string;
  engagementCount: number;
  lastActiveAt: string;
  createdAt: string;
}

interface ChatListEngagementRow {
  id: string;
  business_id: string;
  chat_id: string;
  list_id: string;
  engagement_count: number;
  last_active_at: string;
  created_at: string;
}

function toRecord(row: ChatListEngagementRow): ChatListEngagementRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    chatId: row.chat_id,
    listId: row.list_id,
    engagementCount: row.engagement_count,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
  };
}

/**
 * Relationship-Confidence Engine follow-up: real, narrow engagement
 * history - used only as a tiebreaker (relationshipConfidenceService.ts)
 * when keyword matching alone produces a genuine tie, never a standalone
 * routing signal. RLS'd (migration 1000) - always construct with
 * queryAsTenant(businessId).
 */
export class ChatListEngagementRepository {
  constructor(private readonly db: Queryable) {}

  /** Upsert: increments engagement_count and refreshes last_active_at - never resets on repeat calls. */
  async recordEngagement(businessId: string, chatId: string, listId: string): Promise<ChatListEngagementRecord> {
    const { rows } = await this.db.query<ChatListEngagementRow>(
      `INSERT INTO chat_list_engagement (business_id, chat_id, list_id, engagement_count, last_active_at)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (business_id, chat_id, list_id) DO UPDATE SET
         engagement_count = chat_list_engagement.engagement_count + 1,
         last_active_at = now()
       RETURNING *`,
      [businessId, chatId, listId],
    );
    const row = rows[0];
    if (!row) throw new Error('chat_list_engagement upsert returned no row');
    return toRecord(row);
  }

  /** Missing entries mean "never engaged" - the caller (relationshipConfidenceService.ts) treats an absent candidate as having no real history, never a fabricated zero-recency value. */
  async getEngagementForCandidates(businessId: string, chatId: string, listIds: string[]): Promise<ChatListEngagementRecord[]> {
    if (listIds.length === 0) return [];
    const { rows } = await this.db.query<ChatListEngagementRow>(
      `SELECT * FROM chat_list_engagement WHERE business_id = $1 AND chat_id = $2 AND list_id = ANY($3::uuid[])`,
      [businessId, chatId, listIds],
    );
    return rows.map(toRecord);
  }
}
