import { Queue } from 'bullmq';
import { queueConnection, attachQueueErrorLogging } from '../connection.js';
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
//
// Default is a 3s coalescing window (a customer's burst of messages is
// ingested as one turn once they've gone quiet for 3s), leaving the
// remaining ~1s of a 4s reply-latency target to the actual Gemini call and
// send - the fastest the pipeline can honestly land a reply on the 4th
// second without cutting the ingest window short. This is independent of
// AiAgentRecord.responseDelaySeconds (the per-agent, dashboard-configurable
// human-pacing delay applied after generation) - that is a deliberate
// slow-down knob, not part of this latency budget.
export const AI_DEBOUNCE_MIN_DELAY_MS = 1_000;
export const AI_DEBOUNCE_MAX_DELAY_MS = 30_000;
const AI_DEBOUNCE_DEFAULT_DELAY_MS = 3_000;

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

// Manual-reply-detected auto-pause/resume: a chat auto-paused because the
// business owner typed a reply directly in WhatsApp on the linked device
// (see whatsappMessagePersistenceService.ts's detection, and
// whatsappChatRepository.ts's pauseAiForManualReply/resumeAiIfManualReplyDetected)
// resumes AI_ACTIVE after this many milliseconds of no *further* manual
// reply. Trailing-edge, same as AI_DEBOUNCE_DELAY_MS above: every new manual
// reply resets the countdown rather than letting the first one's timer run
// out mid-conversation.
export const HUMAN_TAKEOVER_RESUME_MIN_DELAY_MS = 5_000;
export const HUMAN_TAKEOVER_RESUME_MAX_DELAY_MS = 10 * 60_000;
const HUMAN_TAKEOVER_RESUME_DEFAULT_DELAY_MS = 20_000;

export const HUMAN_TAKEOVER_RESUME_DELAY_MS = clampedEnvInt(
  'HUMAN_TAKEOVER_RESUME_DELAY_MS',
  HUMAN_TAKEOVER_RESUME_DEFAULT_DELAY_MS,
  HUMAN_TAKEOVER_RESUME_MIN_DELAY_MS,
  HUMAN_TAKEOVER_RESUME_MAX_DELAY_MS,
);

export interface HumanTakeoverResumeJobData {
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
attachQueueErrorLogging(realtimeEventsQueue, 'realtimeEventsQueue');

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

export type ManualMediaRetryOutcome = 'enqueued' | 'already-in-flight' | 'original-job-data-unavailable';

/**
 * Manual retry entry point (Phase 2A proposal section 9). The route calling
 * this only has a mediaId/businessId from Postgres - the raw Baileys
 * mediaDescriptor needed to actually redownload was never persisted there
 * (it only ever existed as BullMQ job data at ingestion time), so rather
 * than requiring the caller to reconstruct it, this reuses the *existing*
 * job's own `.data` under the same deterministic jobId. That job is
 * guaranteed to exist for any row a caller can legitimately retry (the row
 * only reaches 'failed' after that exact job ran), unless Redis's
 * removeOnFail retention has since evicted it - reported honestly as
 * 'original-job-data-unavailable' rather than silently failing.
 *
 * Explicitly checks the existing job's state first: still
 * waiting/active/delayed/prioritized means an automatic retry is genuinely
 * in flight, and the manual attempt is rejected here rather than racing it.
 * Only a job in a real terminal state (completed/failed) is removed and
 * re-added under the same id, since BullMQ will not let two jobs share one
 * otherwise.
 */
export async function enqueueManualMediaRetry(mediaId: string): Promise<ManualMediaRetryOutcome> {
  const jobId = `media-download-${mediaId}`;
  const existing = await realtimeEventsQueue.getJob(jobId);
  if (!existing) {
    return 'original-job-data-unavailable';
  }
  const state = await existing.getState();
  if (state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') {
    return 'already-in-flight';
  }
  const data = existing.data as MediaDownloadJobData;
  await existing.remove();
  await realtimeEventsQueue.add('media-download', data, {
    jobId,
    attempts: MEDIA_DOWNLOAD_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: MEDIA_DOWNLOAD_BACKOFF_DELAY_MS },
  });
  return 'enqueued';
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
    } else if (state === 'active' || state === 'waiting') {
      // A debounce round is genuinely in flight right now for this chat -
      // a fresh add would be rejected/redundant. Any message arriving
      // during this window is still safe: it is picked up either by the
      // next new message's own scheduling attempt once this jobId frees
      // up, or by the backstop sweep (sweepStaleAiHandoff) - never
      // silently lost, just possibly delayed until the next natural
      // trigger.
      return;
    } else {
      // completed/failed: a terminal, stale leftover jobId from a PRIOR
      // round. BullMQ's removeOnComplete/removeOnFail retention is
      // count-based (keeps up to N finished jobs), so on a low-volume
      // queue a finished job can sit under this jobId indefinitely - and
      // `.add()` with an already-existing jobId silently reuses that old,
      // terminal job instead of scheduling a new one. Once a chat's first
      // round ever finished, every later message would otherwise never
      // debounce again. Must be explicitly removed before a fresh round
      // can be scheduled.
      await existing.remove().catch(() => {
        // A concurrent caller may have already removed it - fine, fall through to add() below.
      });
    }
  }

  await realtimeEventsQueue.add('ai-debounce', data, { jobId, delay: AI_DEBOUNCE_DELAY_MS }).catch((error: Error) => {
    // A concurrent scheduling attempt may have just created this exact
    // jobId between our getJob() check and this add() - safe to ignore,
    // it already scheduled the check this call was trying to make.
    console.warn(`[RealtimeEventsQueue] Failed to schedule AI debounce for chat ${data.chatId}: ${error.message}`);
  });
}

/**
 * Trailing-edge resume timer for the manual-reply-detected auto-pause - see
 * HumanTakeoverResumeJobData above. Structurally identical to
 * scheduleAiDebounce: a deterministic jobId per chat so a new manual reply
 * resets the countdown via changeDelay() rather than letting the first
 * reply's timer expire mid-conversation, and the handler
 * (processHumanTakeoverResume in incomingMessagesWorker.ts) re-checks the
 * real chat row at fire time rather than trusting this payload - it must
 * never resume a chat that moved to a different mode/source since this was
 * scheduled (see whatsappChatRepository.ts's resumeAiIfManualReplyDetected).
 */
export async function scheduleHumanTakeoverResume(data: HumanTakeoverResumeJobData): Promise<void> {
  const jobId = `human-takeover-resume-${data.chatId}`;
  const existing = await realtimeEventsQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed') {
      try {
        await existing.changeDelay(HUMAN_TAKEOVER_RESUME_DELAY_MS);
        return;
      } catch {
        // Raced past 'delayed' between getState() and changeDelay() - fall through to a fresh add below.
      }
    } else if (state === 'active' || state === 'waiting') {
      // Already firing right now - the handler re-reads the real chat state
      // at that moment anyway, so there is nothing more useful to do here.
      return;
    } else {
      // completed/failed: a terminal leftover jobId from a prior round - see
      // the identical case in scheduleAiDebounce for why this must be
      // removed before a fresh add() below, not silently reused.
      await existing.remove().catch(() => {
        // A concurrent caller may have already removed it - fine, fall through to add() below.
      });
    }
  }

  await realtimeEventsQueue.add('human-takeover-resume', data, { jobId, delay: HUMAN_TAKEOVER_RESUME_DELAY_MS }).catch((error: Error) => {
    console.warn(`[RealtimeEventsQueue] Failed to schedule human-takeover resume for chat ${data.chatId}: ${error.message}`);
  });
}
