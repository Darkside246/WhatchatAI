import { randomUUID } from 'node:crypto';
import {
  ConversationStateConflictError,
  CONVERSATION_FUNNEL_STAGES,
  CUSTOMER_READINESS_LEVELS,
  type ConversationStateRepository,
  type ConversationFact,
  type ConversationOpenQuestion,
  type ConversationStatePatch,
} from '../../repositories/conversationStateRepository.js';
import { CustomerMemoryConflictError, type CustomerMemoryRepository } from '../../repositories/customerMemoryRepository.js';
import type { UpdateConversationStateToolArgs } from './updateConversationStateTool.js';

/**
 * Bounded retry for the same reason every other optimistic-concurrency
 * caller in this codebase bounds it (see conversationStateRepository.ts's
 * own doc comment): a genuine conflict means re-read and retry, but an
 * unbounded retry loop would turn one AI tool call into a potential
 * infinite loop if something kept writing to this exact row every
 * millisecond. Three attempts is generous for the actual contention this
 * sees today - at most one write per inbound WhatsApp message per chat.
 */
const MAX_CONFLICT_RETRIES = 3;

/**
 * Every fact this function writes is unconditionally stamped
 * 'user_confirmed', regardless of what the tool call args claim - the
 * ConversationFactOrigin type has no 'ai_inferred' option for exactly this
 * reason (see conversationStateRepository.ts), and this is the one
 * production call site that constructs a ConversationFact at all. If a
 * future caller ever needs to record a fact from a different source (a
 * human operator, an external verified system), it must do so through its
 * own explicit origin, never by loosening this one.
 */
function buildPatch(current: { confirmedFacts: ConversationFact[]; openQuestions: ConversationOpenQuestion[] }, args: UpdateConversationStateToolArgs, now: string): ConversationStatePatch {
  const patch: ConversationStatePatch = {};

  if (args.goal !== undefined) {
    const trimmed = args.goal.trim();
    patch.currentGoal = trimmed ? { description: trimmed, setAt: now } : null;
  }

  if (args.confirmFacts?.length) {
    const merged = new Map(current.confirmedFacts.map((fact) => [fact.key, fact]));
    for (const incoming of args.confirmFacts) {
      const key = incoming.key?.trim();
      const value = incoming.value?.trim();
      if (!key || !value) continue;
      merged.set(key, { key, value, origin: 'user_confirmed', confirmedAt: now });
    }
    if (merged.size > 0) patch.confirmedFacts = [...merged.values()];
  }

  if (args.openQuestions?.length || args.resolveQuestions?.length) {
    let questions = current.openQuestions;

    if (args.resolveQuestions?.length) {
      const toResolve = new Set(args.resolveQuestions.map((question) => question.trim().toLowerCase()).filter(Boolean));
      questions = questions.map((question) =>
        !question.resolvedAt && toResolve.has(question.question.trim().toLowerCase())
          ? { ...question, resolvedAt: now }
          : question,
      );
    }

    if (args.openQuestions?.length) {
      // Never opens a duplicate of a question that is already open - the
      // model re-asking about the same thing in a later turn should not
      // grow this list unboundedly.
      const alreadyOpen = new Set(questions.filter((question) => !question.resolvedAt).map((question) => question.question.trim().toLowerCase()));
      const additions: ConversationOpenQuestion[] = [];
      for (const text of args.openQuestions) {
        const trimmed = text.trim();
        if (!trimmed || alreadyOpen.has(trimmed.toLowerCase())) continue;
        alreadyOpen.add(trimmed.toLowerCase());
        additions.push({ id: randomUUID(), question: trimmed, openedAt: now, resolvedAt: null });
      }
      if (additions.length > 0) questions = [...questions, ...additions];
    }

    patch.openQuestions = questions;
  }

  // Current-state snapshots, not accumulating history - overwritten
  // outright, unlike confirmedFacts/openQuestions above. A value outside
  // the known set is silently ignored rather than thrown - the schema's
  // own enum constraint should prevent this, but a tool call is never
  // fully trusted just because the schema says so (same rule as every
  // other tool arg in this codebase).
  if (args.funnelStage !== undefined && (CONVERSATION_FUNNEL_STAGES as readonly string[]).includes(args.funnelStage)) {
    patch.funnelStage = args.funnelStage;
  }
  if (args.customerReadiness !== undefined && (CUSTOMER_READINESS_LEVELS as readonly string[]).includes(args.customerReadiness)) {
    patch.customerReadiness = args.customerReadiness;
  }

  // Section 15 Tier 2 evidence - same clear-on-empty-string convention as
  // goal above. A generous but real cap (a "preferred name" is a word or
  // two, never a paragraph) - never trusted at face value just because
  // it's short, but nothing here validates it's plausible as a name
  // beyond that; identityEngine.ts's caller is still the one deciding
  // whether/how to actually use it.
  if (args.preferredName !== undefined) {
    const trimmed = args.preferredName.trim().slice(0, 100);
    patch.preferredName = trimmed ? trimmed : null;
  }

  return patch;
}

/**
 * Applies one tool call's worth of conversation-memory updates, creating
 * the state row on first write (getOrCreate, never a bare INSERT - see its
 * own doc comment for why this never races unsafely) and retrying on a
 * genuine optimistic-concurrency conflict rather than losing the update.
 * Never throws for "nothing to write" (an empty/no-op tool call) - it
 * simply returns without touching the row, since the model calling this
 * tool with no real content is a prompt-shape issue, not a failure.
 */
export async function applyConversationStateUpdate(
  repository: ConversationStateRepository,
  businessId: string,
  chatId: string,
  args: UpdateConversationStateToolArgs,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    // find(), not getOrCreate() - reading here must never have the
    // side effect of materializing a row, or a genuinely empty tool call
    // would still leave behind an empty conversation_states row.
    const existing = await repository.find(businessId, chatId);
    const now = new Date().toISOString();
    const patch = buildPatch(existing ?? { confirmedFacts: [], openQuestions: [] }, args, now);

    if (Object.keys(patch).length === 0) return;

    // Only now, with real content to write, do we need the row to exist.
    const current = existing ?? (await repository.getOrCreate(businessId, chatId));

    try {
      await repository.update(businessId, chatId, current.version, patch);
      return;
    } catch (error) {
      if (error instanceof ConversationStateConflictError && attempt < MAX_CONFLICT_RETRIES - 1) continue;
      throw error;
    }
  }
}

/**
 * Section 19 (Name Repetition Protection): a system-set write, never a
 * model-reported one - called only after deterministically confirming
 * (identityEngine.ts's replyUsesName) that a reply actually contained the
 * resolved name. Same bounded-retry shape as applyConversationStateUpdate,
 * simplified since there is exactly one field to set.
 */
export async function recordNameUsed(repository: ConversationStateRepository, businessId: string, chatId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const current = await repository.getOrCreate(businessId, chatId);
    try {
      await repository.update(businessId, chatId, current.version, { lastNameUsedAt: new Date().toISOString() });
      return;
    } catch (error) {
      if (error instanceof ConversationStateConflictError && attempt < MAX_CONFLICT_RETRIES - 1) continue;
      throw error;
    }
  }
}

/**
 * Layer 2 write-through: the same real, user-confirmed facts just written
 * to this one conversation's state (above) also get merged into the
 * customer's durable memory (see migration 959), so a returning customer
 * does not have to restate the same fact in their next, unrelated
 * conversation. Only ever called when a real customerId was resolved for
 * this chat (see aiContextGathererService.ts) - group chats and messages
 * from a contact with no linked customer never reach this. Never throws
 * for an empty confirmFacts list - identical "nothing to write" reasoning
 * as applyConversationStateUpdate above.
 */
export async function applyCustomerMemoryUpdate(
  repository: CustomerMemoryRepository,
  businessId: string,
  customerId: string,
  confirmFacts: Array<{ key: string; value: string }> | undefined,
): Promise<void> {
  if (!confirmFacts?.length) return;

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const current = await repository.getOrCreate(businessId, customerId);
    const now = new Date().toISOString();
    const merged = new Map(current.confirmedFacts.map((fact) => [fact.key, fact]));
    for (const incoming of confirmFacts) {
      const key = incoming.key?.trim();
      const value = incoming.value?.trim();
      if (!key || !value) continue;
      merged.set(key, { key, value, origin: 'user_confirmed', confirmedAt: now });
    }
    try {
      await repository.update(businessId, customerId, current.version, [...merged.values()]);
      return;
    } catch (error) {
      if (error instanceof CustomerMemoryConflictError && attempt < MAX_CONFLICT_RETRIES - 1) continue;
      throw error;
    }
  }
}
