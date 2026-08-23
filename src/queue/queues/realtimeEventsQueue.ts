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

// Phase 3B trailing-edge AI debounce config (see
// docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 5). Bounded
// rather than an unconstrained env override: too low defeats the point
// (barely coalesces a fast typist), too high makes every reply feel
// sluggish even for a single, complete message.
export const AI_DEBOUNCE_MIN_DELAY_MS = 1_000;
export const AI_DEBOUNCE_MAX_DELAY_MS = 30_000;
const AI_DEBOUNCE_DEFAULT_DELAY_MS = 6_000;

function clampedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const AI_DEBOUNCE_DELAY_MS = clampedEnvInt(
  'AI_DEBOUNCE_DELAY_MS',
  AI_DEBOUNCE_DEFAULT_DELAY_MS,
  AI_DEBOUNCE_MIN_DELAY_MS,
  AI_DEBOUNCE_MAX_DELAY_MS,
);

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

export interface AiDebounceJobData {
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
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

/**
 * Trailing-edge debounce (Phase 3B, see
 * docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 5). The
 * deterministic jobId (`ai-debounce-<chatId>`) is a "check now" signal
 * only, never a data carrier - the debounce job's handler
 * (processAiDebounce in incomingMessagesWorker.ts) never trusts this
 * payload as authoritative; it re-queries every real unanswered message
 * from Postgres at fire time. A new eligible message resets the countdown
 * via `Job.changeDelay()` rather than letting the first message's own
 * timer run out unmodified, so a customer typing across several messages
 * gets one combined reply after they've gone quiet for
 * `AI_DEBOUNCE_DELAY_MS`, not one reply per message.
 */
export async function scheduleAiDebounce(data: AiDebounceJobData): Promise<void> {
  const jobId = `ai-debounce-${data.chatId}`;
  const existing = await realtimeEventsQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed') {
      try {
        await existing.changeDelay(AI_DEBOUNCE_DELAY_MS);
        return;
      } catch {
        // Raced past 'delayed' (now active/completed) between getState()
        // and changeDelay() - fall through to a fresh add below.
      }
    } else {
      // Already active (a debounce round is running right now for this
      // chat) or waiting/completed with the same jobId still cached - a
      // fresh add would either be rejected (active) or is redundant.
      // Any message arriving during this window is still safe: it is
      // picked up either by the next new message's own scheduling
      // attempt once this jobId frees up, or by the backstop sweep
      // (sweepStaleAiHandoff) - never silently lost, just possibly
      // delayed until the next natural trigger.
      return;
    }
  }

  await realtimeEventsQueue.add('ai-debounce', data, { jobId, delay: AI_DEBOUNCE_DELAY_MS }).catch((error: Error) => {
    // A concurrent scheduling attempt may have just created this exact
    // jobId between our getJob() check and this add() - safe to ignore,
    // it already scheduled the check this call was trying to make.
    console.warn(`[RealtimeEventsQueue] Failed to schedule AI debounce for chat ${data.chatId}: ${error.message}`);
  });
}
