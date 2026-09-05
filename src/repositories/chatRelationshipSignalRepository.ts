import type { Queryable } from './types.js';

export interface RelationshipCandidate {
  listId: string;
  listName: string;
  agentId: string;
  agentName: string;
  matchedKeywords: string[];
  score: number;
  /** Engagement-history follow-up: real recency/frequency, populated only when a chat_list_engagement row exists for this candidate - undefined means never engaged, never a fabricated zero. Shown alongside the keyword score for full transparency, whether or not it was the deciding factor. */
  lastActiveAt?: string;
  engagementCount?: number;
}

export interface ChatRelationshipSignalRecord {
  id: string;
  businessId: string;
  chatId: string;
  candidates: RelationshipCandidate[];
  suggestedListId: string | null;
  computedAt: string;
}

interface ChatRelationshipSignalRow {
  id: string;
  business_id: string;
  chat_id: string;
  candidates: RelationshipCandidate[];
  suggested_list_id: string | null;
  computed_at: string;
}

function toRecord(row: ChatRelationshipSignalRow): ChatRelationshipSignalRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    chatId: row.chat_id,
    candidates: row.candidates,
    suggestedListId: row.suggested_list_id,
    computedAt: row.computed_at,
  };
}

export interface UpsertChatRelationshipSignalInput {
  businessId: string;
  chatId: string;
  candidates: RelationshipCandidate[];
  suggestedListId: string | null;
}

/**
 * Relationship-Confidence Engine (Phase 3): refreshed IN PLACE per chat
 * (not appended) every time listRoutingService.ts recomputes it - "the
 * developer must be able to see this at all times" means always current,
 * never a growing history log. RLS'd (migration 999) - always construct
 * with queryAsTenant(businessId).
 */
export class ChatRelationshipSignalRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(input: UpsertChatRelationshipSignalInput): Promise<ChatRelationshipSignalRecord> {
    const { rows } = await this.db.query<ChatRelationshipSignalRow>(
      `INSERT INTO chat_relationship_signals (business_id, chat_id, candidates, suggested_list_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, chat_id) DO UPDATE SET
         candidates = $3, suggested_list_id = $4, computed_at = now()
       RETURNING *`,
      [input.businessId, input.chatId, JSON.stringify(input.candidates), input.suggestedListId],
    );
    const row = rows[0];
    if (!row) throw new Error('chat_relationship_signals upsert returned no row');
    return toRecord(row);
  }

  async findForChat(businessId: string, chatId: string): Promise<ChatRelationshipSignalRecord | null> {
    const { rows } = await this.db.query<ChatRelationshipSignalRow>(
      `SELECT * FROM chat_relationship_signals WHERE business_id = $1 AND chat_id = $2`,
      [businessId, chatId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Every chat currently carrying 2+ real candidates - the "needs a human look" list the Relationship Resolution panel renders. Genuinely ambiguous rows only (a chat that resolved down to exactly one real candidate isn't ambiguous, even if a signal row exists from an earlier, more-ambiguous state). */
  async listAmbiguousForBusiness(businessId: string, limit = 100): Promise<ChatRelationshipSignalRecord[]> {
    const { rows } = await this.db.query<ChatRelationshipSignalRow>(
      `SELECT * FROM chat_relationship_signals WHERE business_id = $1 AND jsonb_array_length(candidates) >= 2 ORDER BY computed_at DESC LIMIT $2`,
      [businessId, limit],
    );
    return rows.map(toRecord);
  }
}
