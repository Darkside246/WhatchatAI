import { pool } from '../../db/pool.js';
import { WritingTwinRepository } from '../../repositories/writingTwinRepository.js';
import { BusinessMembershipRepository } from '../../repositories/businessMembershipRepository.js';
import { getRawEventRetentionDays } from '../writingTwinService.js';

const repository = new WritingTwinRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);

/**
 * Learn Agent (v1, owner-only per the user's own scoping decision): the
 * missing capture half of Writing Twin/Learn - recordRawEvent() and the
 * rest of the storage layer already existed (Phase W3), nothing ever
 * called them from a real send path. Both entry points below are
 * fire-and-forget from the caller's perspective (never awaited inline on
 * the message-send response) and never throw - a capture failure must
 * never surface to, or slow down, the primary send flow.
 *
 * v1 captures 'human_authored' provenance only. 'ai_generated_then_edited'
 * is deliberately not attempted - there is no existing "edit an AI draft
 * before sending" UI flow anywhere in this app to source a real
 * ai_baseline_text from, and the schema's own CHECK constraint requires
 * one whenever that provenance is used. Building that capture path is
 * future work once such a flow exists.
 */
export class LearnCaptureService {
  /**
   * Hook for the manual WhatsApp send route (POST /api/workspace/chats/:chatId/messages).
   * No-ops unless the sender is this business's OWNER (v1 scope) and the
   * message actually has real text to learn style from - a media-only
   * send (caption aside) carries no writing sample.
   */
  async captureWhatsAppSend(input: {
    businessId: string;
    senderUserId: string;
    text: string | null | undefined;
    outboundMessageId: string;
  }): Promise<void> {
    const text = input.text?.trim();
    if (!text) return;

    try {
      const ownerUserId = await membershipRepository.findOwnerUserId(input.businessId);
      if (!ownerUserId || ownerUserId !== input.senderUserId) return;

      const settings = await repository.getSettings(input.businessId, input.senderUserId);
      if (!settings?.learningEnabled) return;

      await repository.recordRawEvent(
        input.businessId,
        input.senderUserId,
        'whatsapp',
        'human_authored',
        text,
        null,
        'whatsapp_outbound_messages',
        input.outboundMessageId,
        getRawEventRetentionDays(),
      );
    } catch (error) {
      console.error('[LearnCaptureService] Failed to capture WhatsApp send as a Learn raw event:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Hook for a human-authored, human-approved-and-sent email (see
   * emailService.ts's approveAndSend) - never for an AI-drafted email
   * (draftedByAgentId set), which has no honest 'human_authored' claim.
   */
  async captureEmailSend(input: {
    businessId: string;
    /** The email's real author (email_messages.created_by) - never the approver, when the two differ. */
    authorUserId: string;
    bodyText: string | null | undefined;
    emailMessageId: string;
  }): Promise<void> {
    const text = input.bodyText?.trim();
    if (!text) return;

    try {
      const ownerUserId = await membershipRepository.findOwnerUserId(input.businessId);
      if (!ownerUserId || ownerUserId !== input.authorUserId) return;

      const settings = await repository.getSettings(input.businessId, input.authorUserId);
      if (!settings?.learningEnabled) return;

      await repository.recordRawEvent(
        input.businessId,
        input.authorUserId,
        'email',
        'human_authored',
        text,
        null,
        'email_messages',
        input.emailMessageId,
        getRawEventRetentionDays(),
      );
    } catch (error) {
      console.error('[LearnCaptureService] Failed to capture email send as a Learn raw event:', error instanceof Error ? error.message : error);
    }
  }
}

export const learnCaptureService = new LearnCaptureService();
