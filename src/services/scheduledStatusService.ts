import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { ScheduledStatusRepository, type ScheduledStatusRecord, type ScheduledStatusType } from '../repositories/scheduledStatusRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppStatusViewRepository } from '../repositories/whatsappStatusViewRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { resolveDisplayName } from '../domain/whatsapp/displayName.js';
import { resolveChatIdentity } from './chatIdentityService.js';
import { enqueueScheduledStatus } from '../queue/queues/scheduledStatusesQueue.js';
import { enqueueWithTimeout } from '../queue/enqueueWithTimeout.js';
import { storeMedia } from '../media/mediaStorage.js';

const scheduledStatusRepository = new ScheduledStatusRepository(pool);
const messageRepository = new WhatsAppMessageRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);
const statusViewRepository = new WhatsAppStatusViewRepository(pool);
const contactRepository = new WhatsAppContactRepository(pool);

export class ScheduledStatusNotFoundError extends Error {}
export class InvalidScheduledStatusError extends Error {}

const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface CreateScheduledStatusInput {
  statusType: ScheduledStatusType;
  textContent?: string | undefined;
  caption?: string | undefined;
  backgroundColor?: string | undefined;
  mediaBase64?: string | undefined;
  mediaMimeType?: string | undefined;
  scheduledAt: string;
}

async function requireOwn(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  const record = await scheduledStatusRepository.findByIdForBusiness(businessId, id);
  if (!record) throw new ScheduledStatusNotFoundError('Scheduled status not found.');
  return record;
}

export async function createScheduledStatus(
  businessId: string,
  whatsappAccountId: string,
  createdBy: string,
  input: CreateScheduledStatusInput,
): Promise<ScheduledStatusRecord> {
  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
    throw new InvalidScheduledStatusError('scheduledAt must be a real, future timestamp.');
  }

  let mediaStorageReference: string | null = null;
  if (input.statusType !== 'text') {
    if (!input.mediaBase64) throw new InvalidScheduledStatusError(`statusType "${input.statusType}" requires mediaBase64`);
    const buffer = Buffer.from(input.mediaBase64, 'base64');
    if (buffer.length === 0) throw new InvalidScheduledStatusError('Decoded media is empty');
    if (buffer.length > MAX_MEDIA_BYTES) throw new InvalidScheduledStatusError(`Media exceeds the ${MAX_MEDIA_BYTES} byte limit`);
    const sha256Hex = createHash('sha256').update(buffer).digest('hex');
    mediaStorageReference = await storeMedia(businessId, sha256Hex, buffer);
  } else if (!input.textContent?.trim()) {
    throw new InvalidScheduledStatusError('statusType "text" requires non-empty textContent');
  }

  return scheduledStatusRepository.create({
    businessId,
    whatsappAccountId,
    createdBy,
    statusType: input.statusType,
    textContent: input.statusType === 'text' ? (input.textContent ?? null) : null,
    caption: input.caption ?? null,
    backgroundColor: input.backgroundColor ?? null,
    mediaStorageReference,
    mediaMimeType: input.mediaMimeType ?? null,
    scheduledAt: scheduledAt.toISOString(),
  });
}

export async function listScheduledStatuses(businessId: string): Promise<ScheduledStatusRecord[]> {
  return scheduledStatusRepository.listForBusiness(businessId);
}

export async function getScheduledStatus(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  return requireOwn(businessId, id);
}

/**
 * "Status comments" feature: every real reply WhatsApp delivered to this
 * one published status - never a public comment thread (WhatsApp Status
 * has no such thing; a "reply" is a private message to the poster that
 * happens to carry a real reference back to which status it replied to).
 * Only ever returns something for a status that actually published
 * (unpublished ones have no publishedWhatsappMessageId for a reply to
 * reference in the first place).
 */
export interface StatusReply extends WhatsAppMessageRecord {
  /** What a human should see for whoever replied - a real name when one is known, otherwise their real number. Never fabricated. */
  senderName: string;
  /** Their own number when genuinely known, else null. */
  senderPhoneNumber: string | null;
}

export async function listStatusReplies(businessId: string, id: string): Promise<StatusReply[]> {
  await requireOwn(businessId, id);
  const replies = await messageRepository.listRepliesToStatus(businessId, id);

  // A reply carried only a raw sender JID, which is not an answer to "who
  // replied to this" - the panel showed the words and nothing about the
  // person, which is the half that matters for deciding what to post next.
  //
  // Resolved per CHAT rather than per JID, and through the same resolver
  // the inbox and notifications use, so one person is named the same way
  // everywhere. Cached per chat because several replies to one status
  // usually come from a handful of people.
  const identityByChatId = new Map<string, { displayName: string; phoneNumber: string | null }>();
  for (const reply of replies) {
    if (identityByChatId.has(reply.chatId)) continue;
    const chat = await chatRepository.findByIdForBusiness(reply.chatId, businessId);
    if (!chat) continue;
    identityByChatId.set(
      reply.chatId,
      await resolveChatIdentity(businessId, chat.whatsappAccountId, {
        chatJid: chat.chatJid,
        jidKind: chat.jidKind,
        name: chat.name,
        phoneNumber: chat.phoneNumber,
        contactId: chat.contactId,
      }),
    );
  }

  return replies.map((reply) => {
    const identity = identityByChatId.get(reply.chatId);
    return {
      ...reply,
      // Falls back to the sender's real JID rather than to "Unknown": the
      // chat row being missing is a data gap, not a reason to stop saying
      // who this was.
      senderName: identity?.displayName ?? reply.senderJid,
      senderPhoneNumber: identity?.phoneNumber ?? null,
    };
  });
}

/** DRAFT -> SCHEDULED, and the real BullMQ delayed job that will actually fire the publish. */
export async function scheduleStatus(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  const record = await requireOwn(businessId, id);
  if (record.status !== 'DRAFT') throw new InvalidScheduledStatusError(`Status is "${record.status}" - only a DRAFT can be scheduled.`);

  const delayMs = new Date(record.scheduledAt).getTime() - Date.now();
  if (delayMs <= 0) throw new InvalidScheduledStatusError('scheduledAt has already passed - update it before scheduling.');

  const updated = await scheduledStatusRepository.updateStatus(id, 'SCHEDULED');
  if (!updated) throw new ScheduledStatusNotFoundError('Scheduled status not found.');
  // The row is already durably SCHEDULED at this point, so a slow/
  // unreachable Redis must never hang this caller (a real HTTP "schedule
  // this status" request) indefinitely - see enqueueWithTimeout.
  await enqueueWithTimeout(enqueueScheduledStatus({ scheduledStatusId: id }, delayMs), `scheduled status ${id}`);
  return updated;
}

/**
 * Publishes a draft status right now, rather than at a future scheduledAt.
 *
 * The whole status feature was schedule-only: composing something to post
 * immediately meant inventing a time a minute or two ahead and waiting for
 * it. This takes the same DRAFT through the same queue, the same worker and
 * the same real WhatsApp publish - the only difference is a zero delay, so
 * there is no second, parallel publish path that could drift from the
 * scheduled one.
 *
 * scheduledAt is left exactly as the operator set it: it is a record of what
 * they asked for, and rewriting it to "now" would quietly falsify that.
 * DRAFT-only, like scheduleStatus - publishing something already SCHEDULED
 * or PUBLISHED would risk a duplicate post.
 */
export async function publishStatusNow(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  const record = await requireOwn(businessId, id);
  if (record.status !== 'DRAFT') {
    throw new InvalidScheduledStatusError(`Status is "${record.status}" - only a DRAFT can be published immediately.`);
  }

  const updated = await scheduledStatusRepository.updateStatus(id, 'SCHEDULED');
  if (!updated) throw new ScheduledStatusNotFoundError('Scheduled status not found.');
  // Durably SCHEDULED before enqueueing, same ordering as scheduleStatus, so
  // a slow or unreachable Redis can never hang the caller or lose the row.
  await enqueueWithTimeout(enqueueScheduledStatus({ scheduledStatusId: id }, 0), `immediate status ${id}`);
  return updated;
}

export async function cancelScheduledStatus(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  const record = await requireOwn(businessId, id);
  if (record.status !== 'DRAFT' && record.status !== 'SCHEDULED') {
    throw new InvalidScheduledStatusError(`Status is "${record.status}" - it can no longer be cancelled.`);
  }
  const updated = await scheduledStatusRepository.updateStatus(id, 'CANCELLED');
  if (!updated) throw new ScheduledStatusNotFoundError('Scheduled status not found.');
  return updated;
}

export async function deleteScheduledStatus(businessId: string, id: string): Promise<void> {
  const deleted = await scheduledStatusRepository.deleteTerminal(businessId, id);
  if (!deleted) throw new InvalidScheduledStatusError('This status cannot be deleted — it may still be in progress or not found.');
}

export function isScheduledStatusNotFoundError(error: unknown): error is ScheduledStatusNotFoundError {
  return error instanceof ScheduledStatusNotFoundError;
}
export function isInvalidScheduledStatusError(error: unknown): error is InvalidScheduledStatusError {
  return error instanceof InvalidScheduledStatusError;
}


export interface StatusViewer {
  viewerJid: string;
  /** What a human should see - a real name when their contact card has one, otherwise their real number. Never fabricated. */
  displayName: string;
  phoneNumber: string | null;
  viewedAt: string;
}

/**
 * Who actually watched this status.
 *
 * The counterpart to listStatusReplies, and the more useful half: most
 * people who see a post never reply to it, so the reply list is the tip of
 * an audience this answers for directly. Collected from WhatsApp's own read
 * receipts - see the message-receipt.update listener in
 * whatsappTenantConnection.ts - never inferred or estimated.
 *
 * Empty for a status that has not published (no WhatsApp id for a receipt
 * to name), and for one published before this existed: receipts are
 * delivered around the time of the view and are not backfilled, so an older
 * post's audience is genuinely not recoverable rather than merely unread.
 */
export async function listStatusViewers(businessId: string, id: string): Promise<StatusViewer[]> {
  const record = await requireOwn(businessId, id);
  if (!record.publishedWhatsappMessageId) return [];

  const views = await statusViewRepository.listForStatus(businessId, record.publishedWhatsappMessageId);

  return Promise.all(
    views.map(async (view) => {
      // Resolved at read time rather than stored with the view, so a viewer
      // recorded before their contact card synced is still named correctly
      // afterwards.
      const contact = await contactRepository.findByJid(businessId, record.whatsappAccountId, view.viewerJid).catch(() => null);
      return {
        viewerJid: view.viewerJid,
        displayName: resolveDisplayName({
          verifiedName: contact?.verifiedName ?? null,
          businessName: contact?.businessName ?? null,
          displayName: contact?.displayName ?? null,
          username: contact?.username ?? null,
          pushName: contact?.pushName ?? null,
          phoneNumber: contact?.phoneNumber ?? null,
          whatsappJid: view.viewerJid,
        }),
        phoneNumber: contact?.phoneNumber ?? null,
        viewedAt: view.viewedAt,
      };
    }),
  );
}
