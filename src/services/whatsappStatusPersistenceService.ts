import { pool } from '../db/pool.js';
import { WhatsAppStatusRepository } from '../repositories/whatsappStatusRepository.js';
import { WhatsAppMediaRepository } from '../repositories/whatsappMediaRepository.js';
import { enqueueMediaDownload } from '../queue/queues/realtimeEventsQueue.js';
import { enqueueWithTimeout } from '../queue/enqueueWithTimeout.js';
import type { IngestedWhatsAppMessage } from './whatsappMessageIngestionService.js';
import type { MediaType, StatusType } from '../domain/whatsapp/types.js';

const statusRepository = new WhatsAppStatusRepository(pool);
const mediaRepository = new WhatsAppMediaRepository(pool);

const STATUS_TTL_MS = 24 * 60 * 60 * 1000; // WhatsApp Status entries always expire 24h after posting - a real product rule, not a guess.

function mapContentTypeToStatusType(contentType: string): StatusType {
  if (contentType === 'text' || contentType === 'image' || contentType === 'video') return contentType;
  if (contentType === 'audio' || contentType === 'voice_note') return 'audio';
  return 'unknown';
}

function mapStatusTypeToMediaType(statusType: StatusType): MediaType | null {
  if (statusType === 'image' || statusType === 'video' || statusType === 'audio') return statusType;
  return null;
}

/**
 * Baileys has no dedicated status/stories event - status updates arrive as
 * ordinary messages on the fixed status@broadcast JID. They are routed
 * here (never into whatsapp_messages/whatsapp_chats) into the real
 * whatsapp_statuses table. A media-bearing status gets the exact same
 * real download treatment as chat media (whatsapp_media row -> queued
 * download -> checksum-verified, encrypted-at-rest bytes) - only ever
 * queued once, on the genuinely new status insert, never re-queued for a
 * duplicate history-set replay of the same status_id.
 *
 * Shared by two callers with two different execution models, both
 * calling this same synchronous function: the live messages.upsert path
 * (invoked from a queued BullMQ job in incomingMessagesWorker.ts) and
 * the historical messaging-history.set sync path (invoked synchronously,
 * in-process, from whatsappSyncService.ts's ingestHistoryMessages) - see
 * docs/PHASE_1_STATUS_TEXT_FIX_PROPOSAL.md for why the two paths keep
 * their own existing execution models rather than being unified into one.
 */
export async function persistStatusUpdate(
  businessId: string,
  whatsappAccountId: string,
  ingested: IngestedWhatsAppMessage,
): Promise<void> {
  const publisherJid = ingested.participant ?? ingested.remoteJid;
  const createdAt = ingested.messageTimestamp ?? ingested.ingestedAt;
  const statusType = mapContentTypeToStatusType(ingested.contentType);

  const status = await statusRepository.insert({
    businessId,
    whatsappAccountId,
    statusId: ingested.messageId,
    publisherJid,
    statusType,
    textContent: ingested.fullText,
    expiresAt: new Date(new Date(createdAt).getTime() + STATUS_TTL_MS).toISOString(),
  });

  if (!status.wasInserted) return;

  const mediaType = mapStatusTypeToMediaType(statusType);
  if (mediaType && ingested.mediaDescriptor) {
    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId,
      statusId: status.id,
      mediaType,
      mimeType: ingested.mimetype,
      fileName: ingested.fileName,
    });
    await statusRepository.attachMedia(status.id, media.id);
    // Same reasoning as whatsappMessagePersistenceService.persist(): the
    // status/media rows are already durably committed above, so wrapped
    // for the uniform guarantee even though this path is never a
    // synchronous HTTP request either.
    await enqueueWithTimeout(
      enqueueMediaDownload({ businessId, whatsappAccountId, mediaId: media.id, mediaDescriptor: ingested.mediaDescriptor }),
      `status media download ${media.id}`,
    );
  }
}
