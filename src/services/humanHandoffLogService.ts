import { pool } from '../db/pool.js';
import {
  HumanHandoffLogRepository,
  type HandoffReason,
  type HumanHandoffLogEntry,
} from '../repositories/humanHandoffLogRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../repositories/whatsappMessageRepository.js';
import { resolveChatIdentity } from './chatIdentityService.js';

const repository = new HumanHandoffLogRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);
const messageRepository = new WhatsAppMessageRepository(pool);

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
