import { randomUUID } from 'node:crypto';
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

/** Section 06's own funnel stages - the AI decides what stage is appropriate, never forced through every step in order. */
export type ConversationFunnelStage =
  | 'NEW' | 'CONVERSING' | 'INTENT_IDENTIFIED' | 'NEED_IDENTIFIED' | 'QUALIFIED'
  | 'SOLUTION_MATCHED' | 'INTEREST_CONFIRMED' | 'APPOINTMENT_OFFERED'
  | 'APPOINTMENT_SELECTED' | 'BOOKED' | 'FOLLOW_UP' | 'CUSTOMER';

export const CONVERSATION_FUNNEL_STAGES: readonly ConversationFunnelStage[] = [
  'NEW', 'CONVERSING', 'INTENT_IDENTIFIED', 'NEED_IDENTIFIED', 'QUALIFIED',
  'SOLUTION_MATCHED', 'INTEREST_CONFIRMED', 'APPOINTMENT_OFFERED',
  'APPOINTMENT_SELECTED', 'BOOKED', 'FOLLOW_UP', 'CUSTOMER',
];

/** Section 10's own readiness levels - never used to force an appointment on a customer who isn't ready. */
export type CustomerReadiness =
  | 'NOT_READY' | 'BROWSING' | 'NEEDS_INFORMATION' | 'COMPARING'
  | 'INTERESTED' | 'HIGHLY_INTERESTED' | 'READY_TO_ACT' | 'URGENT';

export const CUSTOMER_READINESS_LEVELS: readonly CustomerReadiness[] = [
  'NOT_READY', 'BROWSING', 'NEEDS_INFORMATION', 'COMPARING',
  'INTERESTED', 'HIGHLY_INTERESTED', 'READY_TO_ACT', 'URGENT',
];

export interface ConversationStateRecord {
  id: string;
  businessId: string;
  chatId: string;
  currentGoal: ConversationGoal | null;
  confirmedFacts: ConversationFact[];
  openQuestions: ConversationOpenQuestion[];
  /** Reserved for Phase 3 (ActionBus). Opaque today - nothing reads or writes real content into it yet. */
  pendingActions: unknown[];
  /** Current-state snapshot, not an accumulating history - overwritten on each write, unlike confirmedFacts/openQuestions. Null until the model has ever set it. */
  funnelStage: ConversationFunnelStage | null;
  customerReadiness: CustomerReadiness | null;
  /** Section 15 Tier 2 evidence: what the customer explicitly said to call them, set via update_conversation_memory. Never assumed from a WhatsApp display name - see identityEngine.ts. */
  preferredName: string | null;
  /** Section 19 (Name Repetition Protection): set by the system, never the model, after checking whether a just-sent reply actually used the resolved name. */
  lastNameUsedAt: string | null;
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
  funnel_stage: ConversationFunnelStage | null;
  customer_readiness: CustomerReadiness | null;
  preferred_name: string | null;
  last_name_used_at: string | null;
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
    funnelStage: row.funnel_stage,
    customerReadiness: row.customer_readiness,
    preferredName: row.preferred_name,
    lastNameUsedAt: row.last_name_used_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A valid-shaped ConversationStateRecord for a conversation that has never
 * had state written - never persisted, and its id is not a real row id.
 * Used by read-only callers (aiContextGathererService) so that just
 * gathering context for a reply never has the side effect of creating a
 * permanent row, and never requires chatId to already exist as a real
 * whatsapp_chats row (some callers deliberately pass a syntactically valid
 * but non-existent chatId, e.g. document-retrieval-only tests). The real
 * row is created lazily, on first actual write, by update()'s caller
 * calling getOrCreate() at that point - not by merely reading context.
 */
export function emptyConversationState(businessId: string, chatId: string): ConversationStateRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    businessId,
    chatId,
    currentGoal: null,
    confirmedFacts: [],
    openQuestions: [],
    pendingActions: [],
    funnelStage: null,
    customerReadiness: null,
    preferredName: null,
    lastNameUsedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
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
  funnelStage?: ConversationFunnelStage | null;
  customerReadiness?: CustomerReadiness | null;
  preferredName?: string | null;
  lastNameUsedAt?: string | null;
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
   * Section 09 (Next-Best-Action Engine) real signal source: conversations
   * where the AI itself has assessed the customer as READY_TO_ACT or
   * URGENT (set via update_conversation_memory - never fabricated here),
   * but which the AI has NOT already escalated to HUMAN_TAKEOVER and which
   * haven't already converted (BOOKED/CUSTOMER) - a genuinely distinct
   * signal from "chat needs human" (that only fires on an explicit AI
   * handoff): a human may want to jump into a conversation the AI is still
   * confidently handling, specifically because the AI has flagged real
   * urgency or readiness to close.
   */
  async listHighReadinessForBusiness(businessId: string, limit = 20): Promise<Array<{ chatId: string; displayName: string; readiness: CustomerReadiness; updatedAt: string }>> {
    const { rows } = await this.db.query<{ chat_id: string; name: string | null; phone_number: string | null; customer_readiness: CustomerReadiness; updated_at: string }>(
      `SELECT cs.chat_id, wc.name, wc.phone_number, cs.customer_readiness, cs.updated_at
       FROM conversation_states cs
       JOIN whatsapp_chats wc ON wc.id = cs.chat_id AND wc.business_id = cs.business_id
       WHERE cs.business_id = $1
         AND cs.customer_readiness IN ('READY_TO_ACT', 'URGENT')
         AND (cs.funnel_stage IS NULL OR cs.funnel_stage NOT IN ('BOOKED', 'CUSTOMER'))
         AND wc.ai_mode != 'HUMAN_TAKEOVER'
         AND wc.deleted_at IS NULL
       ORDER BY cs.updated_at ASC
       LIMIT $2`,
      [businessId, limit],
    );
    return rows.map((row) => ({
      chatId: row.chat_id,
      displayName: row.name ?? row.phone_number ?? 'a contact',
      readiness: row.customer_readiness,
      updatedAt: row.updated_at,
    }));
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
    if (patch.funnelStage !== undefined) { values.push(patch.funnelStage); sets.push(`funnel_stage = $${values.length}`); }
    if (patch.customerReadiness !== undefined) { values.push(patch.customerReadiness); sets.push(`customer_readiness = $${values.length}`); }
    if (patch.preferredName !== undefined) { values.push(patch.preferredName); sets.push(`preferred_name = $${values.length}`); }
    if (patch.lastNameUsedAt !== undefined) { values.push(patch.lastNameUsedAt); sets.push(`last_name_used_at = $${values.length}`); }

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
