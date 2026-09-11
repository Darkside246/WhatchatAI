import { pool } from '../db/pool.js';
import {
  HumanHandoffLogRepository,
  type HandoffReason,
  type HumanHandoffLogEntry,
} from '../repositories/humanHandoffLogRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../repositories/whatsappMessageRepository.js';
import { resolveChatIdentity } from './chatIdentityService.js';
import { WritingTwinRepository, type WritingTwinStyleExampleRecord } from '../repositories/writingTwinRepository.js';
import type { ChannelScope } from '../domain/writingTwin/types.js';

const repository = new HumanHandoffLogRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);
const messageRepository = new WhatsAppMessageRepository(pool);
const writingTwinRepository = new WritingTwinRepository(pool);

export interface RecordHandoffParams {
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
  reason: HandoffReason;
  /** The specific detail behind the reason, when there is one - e.g. the blocked keyword that matched. */
  reasonDetail?: string | null;
  /** The message that triggered the takeover, when one did. Its text is excerpted into the log so the entry is readable without a join. */
  messageId?: string | null;
}

/**
 * Records one real human-handoff event, resolving the customer's identity
 * at write time.
 *
 * Resolved at write time rather than read time on purpose: the log has to
 * stay truthful about who the conversation was with even if the contact is
 * later renamed, merged, or deleted. It is the historical record of an
 * event, not a live view.
 *
 * Best-effort by design. Every caller is on a path where a customer is
 * already waiting - failing to write an audit row must never break the
 * takeover itself, so this never throws.
 */
export async function recordHumanHandoff(params: RecordHandoffParams): Promise<void> {
  try {
    const chat = await chatRepository.findByIdForBusiness(params.chatId, params.businessId);
    if (!chat) return;

    const identity = await resolveChatIdentity(params.businessId, params.whatsappAccountId, chat);

    let messageExcerpt: string | null = null;
    if (params.messageId) {
      const message = await messageRepository.findByIdForBusiness(params.messageId, params.businessId);
      messageExcerpt = message?.textContent ?? null;
    }

    await repository.record({
      businessId: params.businessId,
      chatId: params.chatId,
      messageId: params.messageId ?? null,
      reason: params.reason,
      reasonDetail: params.reasonDetail ?? null,
      customerLabel: identity.displayName,
      customerPhone: identity.phoneNumber,
      messageExcerpt,
    });
  } catch (error) {
    console.error(
      '[humanHandoffLogService] Failed to record a handoff event - the takeover itself was unaffected:',
      error instanceof Error ? error.message : error,
    );
  }
}

export async function listHandoffLog(
  businessId: string,
  limit?: number,
  offset?: number,
): Promise<{ entries: HumanHandoffLogEntry[]; total: number }> {
  const [entries, total] = await Promise.all([
    repository.list(businessId, limit, offset),
    repository.count(businessId),
  ]);
  return { entries, total };
}

export async function deleteHandoffLogEntry(businessId: string, id: string): Promise<boolean> {
  return repository.deleteEntry(businessId, id);
}

export async function clearHandoffLog(businessId: string): Promise<number> {
  return repository.clear(businessId);
}


/**
 * What the Writing Twin has actually learned from this user's own writing.
 *
 * Deliberately lives next to the handoff log and behind the same gate: these
 * are verbatim excerpts of real messages the user wrote, so the same
 * app-lock PIN that protects the handoff log protects them. Shown as its own
 * category rather than mixed in - they answer a different question ("what
 * has it learned about how I write" vs "why did a conversation leave the
 * AI").
 *
 * Every scope is read in one call so the viewer can show the whole picture
 * rather than making the operator hunt per channel. Text comes back
 * decrypted by the repository; it is encrypted at rest like every other
 * message excerpt in this system.
 */
export async function listWritingSamples(
  businessId: string,
  userId: string,
  limitPerScope = 100,
): Promise<{ scope: ChannelScope; examples: WritingTwinStyleExampleRecord[] }[]> {
  const scopes: ChannelScope[] = ['global', 'whatsapp', 'email'];
  return Promise.all(
    scopes.map(async (scope) => ({
      scope,
      examples: await writingTwinRepository.listStyleExamples(businessId, userId, scope, limitPerScope),
    })),
  );
}

/** Forgets one learned sample. A real delete - the user is entitled to remove something the system learned from them. */
export async function deleteWritingSample(businessId: string, userId: string, exampleId: string): Promise<void> {
  await writingTwinRepository.deleteStyleExample(businessId, userId, exampleId);
}
