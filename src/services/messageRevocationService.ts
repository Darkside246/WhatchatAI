import { pool } from '../db/pool.js';
import { WhatsAppMessageRepository } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { CampaignRepository } from '../repositories/campaignRepository.js';
import { ScheduledStatusRepository } from '../repositories/scheduledStatusRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { enqueueRevocation } from '../queue/queues/messageRevocationsQueue.js';
import { enqueueWithTimeout } from '../queue/enqueueWithTimeout.js';

const messageRepository = new WhatsAppMessageRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);
const campaignRepository = new CampaignRepository(pool);
const scheduledStatusRepository = new ScheduledStatusRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class RevocationNotFoundError extends Error {}
export class NotRevocableError extends Error {}

/**
 * Real pacing between the individual revokes of a campaign recall. A recall
 * of 100 messages is 100 separate WhatsApp sends; firing them in one instant
 * is exactly the pattern that gets an account flagged. Matches the stagger
 * the campaign send itself uses.
 */
const RECALL_STAGGER_MS = 1500;

/**
 * WhatsApp itself only offers "delete for everyone" for a limited period
 * after sending. We do not silently attempt revokes far outside that window
 * and report success - we refuse up front and say why. The value is
 * WhatsApp's documented limit for delete-for-everyone at the time of
 * writing; if WhatsApp widens it, this only ever makes us stricter than the
 * phone, never looser.
 */
const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000; // 2 days 12 hours

export interface RevocationOutcome {
  /** How many messages we genuinely queued a revoke instruction for. */
  queued: number;
  /** Messages we deliberately did not attempt, with the real reason. */
  skipped: { messageId: string; reason: string }[];
}

function isWithinWindow(timestamp: string): boolean {
  const sentAt = new Date(timestamp).getTime();
  if (Number.isNaN(sentAt)) return false;
  return Date.now() - sentAt <= DELETE_FOR_EVERYONE_WINDOW_MS;
}

/**
 * Deletes one of our own messages off WhatsApp for everyone - the same
 * action the phone offers.
 *
 * Refuses anything we could not honestly carry out: someone else's message
 * (WhatsApp only lets the author revoke), a message outside the
 * delete-for-everyone window, or one already revoked. On success the
 * message is left in 'requested' until the worker gets a real acceptance
 * back from WhatsApp.
 */
export async function revokeMessage(businessId: string, messageId: string, requestedBy: string): Promise<void> {
  const message = await messageRepository.findByIdForBusiness(messageId, businessId);
  if (!message) throw new RevocationNotFoundError('Message not found.');

  if (!message.fromMe) {
    throw new NotRevocableError('WhatsApp only lets the sender delete a message for everyone - this one is not yours.');
  }
  if (message.revokeStatus === 'requested' || message.revokeStatus === 'revoke_sent') {
    throw new NotRevocableError('A delete has already been requested for this message.');
  }
  if (!isWithinWindow(message.timestamp)) {
    throw new NotRevocableError('This message is older than WhatsApp’s delete-for-everyone window, so it can no longer be deleted for everyone.');
  }

  const chat = await chatRepository.findByIdForBusiness(message.chatId, businessId);
  if (!chat) throw new RevocationNotFoundError('Chat not found.');

  const claimed = await messageRepository.markRevokeRequested(messageId, businessId, requestedBy);
  if (!claimed) throw new NotRevocableError('This message can no longer be deleted for everyone.');

  // markRevokeRequested is already durably committed above, so a slow/
  // unreachable Redis must never hang this caller (a real HTTP
  // "delete for everyone" request) indefinitely - see enqueueWithTimeout.
  await enqueueWithTimeout(
    enqueueRevocation({ kind: 'message', messageId, businessId, whatsappAccountId: message.whatsappAccountId }),
    `message revocation ${messageId}`,
  );

  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: message.whatsappAccountId,
    eventType: 'message_revoke_requested',
    rawMetadata: { messageId, chatId: message.chatId, requestedBy },
  });
}

/**
 * Recalls a campaign: issues a real delete-for-everyone for each message the
 * campaign actually put on WhatsApp.
 *
 * Recipients that never received a message are not counted, and messages
 * past WhatsApp's window are reported as skipped with the real reason rather
 * than folded silently into a success number.
 */
export async function recallCampaign(businessId: string, campaignId: string, requestedBy: string): Promise<RevocationOutcome> {
  const campaign = await campaignRepository.findByIdForBusiness(businessId, campaignId);
  if (!campaign) throw new RevocationNotFoundError('Campaign not found.');

  const candidates = await campaignRepository.listRevocableMessageIds(campaignId);
  const skipped: RevocationOutcome['skipped'] = [];
  let queued = 0;

  for (const candidate of candidates) {
    const message = await messageRepository.findByIdForBusiness(candidate.messageId, businessId);
    if (!message) continue;
    if (!isWithinWindow(message.timestamp)) {
      skipped.push({ messageId: candidate.messageId, reason: 'Past WhatsApp’s delete-for-everyone window' });
      continue;
    }

    const claimed = await messageRepository.markRevokeRequested(candidate.messageId, businessId, requestedBy);
    if (!claimed) {
      skipped.push({ messageId: candidate.messageId, reason: 'Already being deleted' });
      continue;
    }

    await enqueueWithTimeout(
      enqueueRevocation(
        { kind: 'message', messageId: candidate.messageId, businessId, whatsappAccountId: candidate.whatsappAccountId },
        queued * RECALL_STAGGER_MS,
      ),
      `campaign recall message ${candidate.messageId}`,
    );
    queued += 1;
  }

  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: campaign.whatsappAccountId,
    eventType: 'campaign_recalled',
    rawMetadata: { campaignId, queued, skipped: skipped.length, requestedBy },
  });

  return { queued, skipped };
}

/** Recalls a Status post we published. Only possible when we stored the real key WhatsApp gave us at publish time. */
export async function revokeScheduledStatus(businessId: string, scheduledStatusId: string, requestedBy: string): Promise<void> {
  const record = await scheduledStatusRepository.findByIdForBusiness(businessId, scheduledStatusId);
  if (!record) throw new RevocationNotFoundError('Status post not found.');

  if (record.status !== 'PUBLISHED') {
    throw new NotRevocableError(`This post is "${record.status}" - only a published post can be deleted from WhatsApp.`);
  }
  if (!record.publishedWhatsappMessageId) {
    throw new NotRevocableError('This post was published before delete-from-WhatsApp existed, so there is no key to recall it with.');
  }
  if (record.revokeStatus === 'requested' || record.revokeStatus === 'revoke_sent') {
    throw new NotRevocableError('A delete has already been requested for this post.');
  }

  const claimed = await scheduledStatusRepository.markRevokeRequested(scheduledStatusId, businessId);
  if (!claimed) throw new NotRevocableError('This post can no longer be deleted from WhatsApp.');

  await enqueueWithTimeout(
    enqueueRevocation({ kind: 'status', scheduledStatusId, businessId, whatsappAccountId: record.whatsappAccountId }),
    `status revocation ${scheduledStatusId}`,
  );

  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: record.whatsappAccountId,
    eventType: 'status_revoke_requested',
    rawMetadata: { scheduledStatusId, requestedBy },
  });
}

export function isRevocationNotFoundError(error: unknown): error is RevocationNotFoundError {
  return error instanceof RevocationNotFoundError;
}
export function isNotRevocableError(error: unknown): error is NotRevocableError {
  return error instanceof NotRevocableError;
}
