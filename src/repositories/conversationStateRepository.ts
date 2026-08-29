import type { Queryable } from './types.js';

/**
 * origin deliberately has no 'ai_inferred' option - an unconfirmed AI guess
 * has no valid shape to become a ConversationFact. It belongs in
 * openQuestions (or nowhere yet) until something with actual authority
 * (the user, a system computation, an external verified source) confirms
 * it. This is a structural constraint, not just a naming convention: code
 * cannot construct a "confirmed" fact from a bare AI inference without
 * fabricating an origin value that doesn't type-check.
 */
export type ConversationFactOrigin = 'user_confirmed' | 'system_confirmed' | 'external_verified';

export interface ConversationFact {
  key: string;
  value: string;
  origin: ConversationFactOrigin;
  confirmedAt: string;
}

export interface ConversationGoal {
  description: string;
  setAt: string;
}

export interface ConversationOpenQuestion {
  id: string;
  question: string;
  openedAt: string;
  resolvedAt: string | null;
}

export interface ConversationStateRecord {
  id: string;
  businessId: string;
  chatId: string;
  currentGoal: ConversationGoal | null;
  confirmedFacts: ConversationFact[];
  openQuestions: ConversationOpenQuestion[];
  /** Reserved for Phase 3 (ActionBus). Opaque today - nothing reads or writes real content into it yet. */
  pendingActions: unknown[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ConversationStateRow {
  id: string;
  business_id: string;
  chat_id: string;
  current_goal: ConversationGoal | null;
  confirmed_facts: ConversationFact[];
  open_questions: ConversationOpenQuestion[];
  pending_actions: unknown[];
  version: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ConversationStateRow): ConversationStateRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    chatId: row.chat_id,
    currentGoal: row.current_goal,
    confirmedFacts: row.confirmed_facts,
    openQuestions: row.open_questions,
    pendingActions: row.pending_actions,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Thrown by update() when expectedVersion no longer matches the stored row - the caller must re-read and retry, never assume its write applied. */
export class ConversationStateConflictError extends Error {
  constructor(businessId: string, chatId: string, expectedVersion: number) {
    super(`Conversation state for chat ${chatId} (business ${businessId}) was not at version ${expectedVersion} - re-read and retry`);
    this.name = 'ConversationStateConflictError';
  }
}

export interface ConversationStatePatch {
  currentGoal?: ConversationGoal | null;
  confirmedFacts?: ConversationFact[];
  openQuestions?: ConversationOpenQuestion[];
  pendingActions?: unknown[];
}

export class ConversationStateRepository {
  constructor(private readonly db: Queryable) {}

  async find(businessId: string, chatId: string): Promise<ConversationStateRecord | null> {
    const { rows } = await this.db.query<ConversationStateRow>(
      `SELECT * FROM conversation_states WHERE business_id = $1 AND chat_id = $2`,
      [businessId, chatId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Idempotent: a conversation that already has state gets it back unchanged; one that doesn't gets a fresh, empty row. Never overwrites an existing row. */
  async getOrCreate(businessId: string, chatId: string): Promise<ConversationStateRecord> {
    const existing = await this.find(businessId, chatId);
    if (existing) return existing;

    const { rows } = await this.db.query<ConversationStateRow>(
      `INSERT INTO conversation_states (business_id, chat_id)
       VALUES ($1, $2)
       ON CONFLICT (business_id, chat_id) DO NOTHING
       RETURNING *`,
      [businessId, chatId],
    );
    if (rows[0]) return toRecord(rows[0]);
    // Lost the race to a concurrent getOrCreate() for the same chat - the
    // other caller's row is now the real one; read it rather than treat
    // this as a failure.
    const created = await this.find(businessId, chatId);
    if (!created) throw new Error('conversation_states getOrCreate found no row after a conflicting insert');
    return created;
  }

  /**
   * Optimistic-concurrency patch: only the fields present in patch are
   * changed, and the write only lands if the row is still at
   * expectedVersion (the version the caller read before deciding what to
   * write). A conflict throws ConversationStateConflictError instead of
   * silently overwriting a concurrent update - the caller re-reads,
   * re-evaluates its patch against the new state, and retries.
   */
  async update(
    businessId: string,
    chatId: string,
    expectedVersion: number,
    patch: ConversationStatePatch,
  ): Promise<ConversationStateRecord> {
    const sets: string[] = ['version = version + 1', 'updated_at = now()'];
    const values: unknown[] = [businessId, chatId, expectedVersion];
    if (patch.currentGoal !== undefined) { values.push(JSON.stringify(patch.currentGoal)); sets.push(`current_goal = $${values.length}::jsonb`); }
    if (patch.confirmedFacts !== undefined) { values.push(JSON.stringify(patch.confirmedFacts)); sets.push(`confirmed_facts = $${values.length}::jsonb`); }
    if (patch.openQuestions !== undefined) { values.push(JSON.stringify(patch.openQuestions)); sets.push(`open_questions = $${values.length}::jsonb`); }
    if (patch.pendingActions !== undefined) { values.push(JSON.stringify(patch.pendingActions)); sets.push(`pending_actions = $${values.length}::jsonb`); }

    const { rows } = await this.db.query<ConversationStateRow>(
      `UPDATE conversation_states SET ${sets.join(', ')}
       WHERE business_id = $1 AND chat_id = $2 AND version = $3
       RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw new ConversationStateConflictError(businessId, chatId, expectedVersion);
    return toRecord(row);
  }
}
