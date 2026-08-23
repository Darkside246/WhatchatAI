import { Queue } from 'bullmq';
import { queueConnection } from '../connection.js';
import type { MessageStatus } from '../../domain/whatsapp/types.js';
import type { WACallEvent, PresenceData, proto } from '@whiskeysockets/baileys';
import type { IngestedWhatsAppMessage } from '../../services/whatsappMessageIngestionService.js';

export const REALTIME_EVENTS_QUEUE = 'realtime_events';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Phase 2B media-retry config (see
// docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md sections 3/5) - set as
// explicit per-job options on the media-download job below rather than
// relying on this queue's shared defaultJobOptions, since that default
// (attempts: 3, backoff 1000ms exponential) is also used by every other job
// type on this queue (call-event, message-status, etc.), which are outside
// this phase's scope and must not change behavior.
export const MEDIA_DOWNLOAD_MAX_ATTEMPTS = envInt('MEDIA_DOWNLOAD_MAX_ATTEMPTS', 3);
export const MEDIA_DOWNLOAD_BACKOFF_DELAY_MS = envInt('MEDIA_DOWNLOAD_BACKOFF_DELAY_MS', 1000);

export interface MessageStatusJobData {
  businessId: string;
  whatsappAccountId: string;
  whatsappMessageId: string;
  status: MessageStatus;
}

export interface CallEventJobData {
  businessId: string;
  whatsappAccountId: string;
  event: WACallEvent;
}

export interface StatusUpdateJobData {
  businessId: string;
  whatsappAccountId: string;
  ingested: IngestedWhatsAppMessage;
}

export interface MediaDownloadJobData {
  businessId: string;
  whatsappAccountId: string;
  mediaId: string;
  /** Base64-encoded raw Baileys {key, message} - see binaryCodec.ts. */
  mediaDescriptor: Record<string, unknown>;
}

export interface MessageReactionJobData {
  businessId: string;
  whatsappAccountId: string;
  accountJid: string;
  /** The WhatsApp message ID being reacted to (content.reactionMessage.key.id, before Baileys overwrites reaction.key with the reaction envelope's own key). */
  targetWhatsappMessageId: string;
  /** Real proto.IReaction from Baileys' messages.reaction event - reaction.key identifies the reactor, reaction.text is the emoji (falsy = removed). No Buffer fields, safe for direct JSON. */
  reaction: proto.IReaction;
}

export interface PresenceUpdateJobData {
  businessId: string;
  whatsappAccountId: string;
  contactJid: string;
  presence: PresenceData;
}

/**
 * Lightweight, non-Sentinel-gated background jobs: delivery-receipt status
 * updates and call events. Kept off the Baileys event loop for the same
 * reason as incoming_messages (no synchronous DB write on that turn), but
 * separate from that queue since these never carry new message content that
 * needs security screening.
 */
export const realtimeEventsQueue = new Queue(REALTIME_EVENTS_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export function enqueueMessageStatus(data: MessageStatusJobData): Promise<unknown> {
  return realtimeEventsQueue.add('message-status', data);
}

export function enqueueCallEvent(data: CallEventJobData): Promise<unknown> {
  return realtimeEventsQueue.add('call-event', data);
}

export function enqueueStatusUpdate(data: StatusUpdateJobData): Promise<unknown> {
  return realtimeEventsQueue.add('status-update', data);
}

/**
 * Deterministic jobId (Phase 2B, see
 * docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md section 4): BullMQ
 * rejects a second `.add()` for a jobId that is already
 * waiting/active/delayed, so two enqueue attempts for the same mediaId
 * (e.g. a future manual retry racing an in-flight automatic one) can never
 * produce two concurrent jobs for the same media. Automatic retries within
 * the state machine's attempts budget reuse this same job instance via
 * BullMQ's own attempts/backoff (the handler throws rather than
 * re-enqueuing), so this only guards against duplicate *enqueue* calls, not
 * retry scheduling.
 */
export function enqueueMediaDownload(data: MediaDownloadJobData): Promise<unknown> {
  return realtimeEventsQueue.add('media-download', data, {
    // BullMQ rejects a custom jobId containing ':' (it uses colons as its
    // own Redis key separator) - dash-joined instead.
    jobId: `media-download-${data.mediaId}`,
    attempts: MEDIA_DOWNLOAD_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: MEDIA_DOWNLOAD_BACKOFF_DELAY_MS },
  });
}

export function enqueueMessageReaction(data: MessageReactionJobData): Promise<unknown> {
  return realtimeEventsQueue.add('message-reaction', data);
}

export function enqueuePresenceUpdate(data: PresenceUpdateJobData): Promise<unknown> {
  return realtimeEventsQueue.add('presence-update', data);
}
