import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { downloadMediaMessage, type WAMessage, type WAMessageKey, type proto } from '@whiskeysockets/baileys';
import { queueConnection } from '../connection.js';
import { INCOMING_MESSAGES_QUEUE, type IncomingMessageJobData } from '../queues/incomingMessagesQueue.js';
import {
  REALTIME_EVENTS_QUEUE,
  realtimeEventsQueue,
  MEDIA_DOWNLOAD_MAX_ATTEMPTS,
  MEDIA_DOWNLOAD_BACKOFF_DELAY_MS,
  scheduleAiDebounce,
  type MessageStatusJobData,
  type CallEventJobData,
  type StatusUpdateJobData,
  type MediaDownloadJobData,
  type MessageReactionJobData,
  type PresenceUpdateJobData,
  type AiDebounceJobData,
  type HumanTakeoverResumeJobData,
} from '../queues/realtimeEventsQueue.js';
import { whatsappMessagePersistenceService } from '../../services/whatsappMessagePersistenceService.js';
import { persistStatusUpdate } from '../../services/whatsappStatusPersistenceService.js';
import { runSentinel } from '../../security/sentinel/sentinel.js';
import { orchestrateAiReply } from '../../services/ai/aiOrchestrator.js';
import { timeService } from '../../services/time/timeService.js';
import { whatsappOutboundMessageService } from '../../services/whatsappOutboundMessageService.js';
import { WhatsAppChatRepository } from '../../repositories/whatsappChatRepository.js';
import { CrmContactRepository } from '../../repositories/crmContactRepository.js';
import { notifyBusiness } from '../../services/notificationService.js';
import { publishRealtimeEvent } from '../../realtime/pubsub.js';
import { pool } from '../../db/pool.js';
import { WhatsAppMessageRepository } from '../../repositories/whatsappMessageRepository.js';
import { WhatsAppCallRepository } from '../../repositories/whatsappCallRepository.js';
import { WhatsAppMediaRepository } from '../../repositories/whatsappMediaRepository.js';
import { WhatsAppMessageReactionRepository } from '../../repositories/whatsappMessageReactionRepository.js';
import { WhatsAppPresenceRepository } from '../../repositories/whatsappPresenceRepository.js';
import { WhatsAppSyncJobRepository } from '../../repositories/whatsappSyncJobRepository.js';
import { WhatsAppAccountRepository } from '../../repositories/whatsappAccountRepository.js';
import { WhatsAppOutboundMessageRepository } from '../../repositories/whatsappOutboundMessageRepository.js';
import { EmailMessageRepository } from '../../repositories/emailMessageRepository.js';
import { mapBaileysCallStatus, callTypeFromEvent, isTerminalCallStatus } from '../../domain/whatsapp/callStatus.js';
import { classifyJid, derivePhoneNumber } from '../../domain/whatsapp/jid.js';
import { decodeBuffersFromQueue } from '../../domain/whatsapp/binaryCodec.js';
import { storeMedia } from '../../media/localEncryptedMediaStorage.js';
import { mediaFallbackText } from '../../services/ai/mediaContext.js';
import { sweepStaleFunnelInstances } from '../../services/funnelService.js';
import { runSecurityScan } from '../../services/securityScanService.js';
import { runSecurityWatcher } from '../../services/openclawSecurityWatcherService.js';
import type { WhatsAppMessageRecord } from '../../repositories/whatsappMessageRepository.js';
import type { WhatsAppMediaRecord } from '../../repositories/whatsappMediaRepository.js';
import type { MediaDownloadErrorCategory } from '../../domain/whatsapp/types.js';
import { verifyMasterKeyStability } from '../../security/encryption/keyStabilityCheck.js';
import { installCrashSafetyHandlers } from '../../process/crashSafety.js';
import { OperatorCommandService } from '../../services/operator/operatorCommandService.js';
import { initializePlatformFoundation } from '../../services/platform/platformBootstrap.js';
import { runPropertyMaintenanceHandoff } from '../../services/property/propertyMaintenanceOrchestrator.js';
// Runs here, not in server/index.ts: that process owns the live Baileys
// socket AND sends every outbound message, so it is exactly the event loop
// that must never stall. documentParseWorker has no live-socket dependency
// (pure DB/media/CPU work parsing uploaded PDFs/DOCX), so it belongs
// wherever that isn't - this process, which already has no HTTP-facing or
// socket-owning responsibilities of its own.
import { documentParseWorker } from './documentParseWorker.js';

// Fail loud here, at boot, before either Worker below starts pulling jobs -
// see keyStabilityCheck.ts. A top-level await, so nothing further in this
// module (including the Worker constructions) runs until it resolves.
await verifyMasterKeyStability();

// Registers the AiGateway provider chain and the property maintenance
// triage skill - this worker process is where runAiHandoff actually calls
// them, so without this every property triage call fails with "skill
// property.maintenance.triage is disabled" / "no eligible AI provider".
initializePlatformFoundation();

/**
 * Drains the incoming_messages queue and performs the real Postgres
 * persistence (contact/chat upsert + encrypted message insert) off the
 * Baileys WebSocket event loop. Run as its own process: `npm run dev:worker`.
 *
 * The Tiered Security Sentinel runs here, in the background worker, before
 * any business logic: messages the Sentinel blocks are logged to
 * security_audit_logs and never reach persistence.
 */
async function processJob(job: Job<IncomingMessageJobData>): Promise<void> {
  const { businessId, whatsappAccountId, accountJid, message } = job.data;

  const verdict = await runSentinel({
    businessId,
    whatsappAccountId,
    senderJid: message.fromMe ? accountJid : (message.participant ?? message.remoteJid),
    textContent: message.textPreview,
    mimetype: message.mimetype,
    fileName: message.fileName,
  });

  if (!verdict.allowed) {
    console.warn(`[IncomingMessagesWorker] Sentinel blocked message ${message.messageId}: ${verdict.reason}`);
    return;
  }

  const result = await whatsappMessagePersistenceService.persist({
    businessId,
    whatsappAccountId,
    accountJid,
    ingested: message,
  });

  if (result.message.wasInserted) {
    await publishRealtimeEvent({ type: 'message.new', businessId, chatId: result.chat.id });
    await publishRealtimeEvent({ type: 'chat.updated', businessId, chatId: result.chat.id });

    // The message we just persisted may be the echo of our own outbound
    // send (Baileys re-delivers a sent message through the same
    // messages.upsert path, fromMe: true) - link it back to the send
    // request that triggered it, best-effort, so the outbound row's
    // message_id catches up once this async persistence completes.
    if (message.fromMe) {
      await outboundMessageRepository
        .linkPersistedMessage(whatsappAccountId, result.message.whatsappMessageId, result.message.id)
        .catch((error) => {
          console.error('[IncomingMessagesWorker] Failed to link outbound message:', error);
        });
    }
  }

  // Only a genuinely new, live, inbound message in an AI-driven chat needs a
  // response - not duplicates, not historical backfill, not our own outbound
  // sends, and not chats a human has taken over. A media message (with or
  // without a caption) is handled separately, once its real bytes have
  // actually finished downloading - see maybeTriggerMediaAiHandoff below,
  // called from processMediaDownload. Firing here too would mean the AI
  // either replies before it can see/hear the media, or (worse) never gets
  // asked at all for a caption-less one.
  //
  // Phase 3B: this no longer calls runAiHandoff directly. Instead it
  // schedules (or resets) a trailing-edge debounce - see scheduleAiDebounce
  // and processAiDebounce below - so a customer typing a thought across
  // several rapid messages gets one combined reply, not one Gemini call per
  // message. See docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 5.
  const needsAiHandoff =
    result.message.wasInserted &&
    !message.fromMe &&
    message.isLive &&
    result.chat.aiMode === 'AI_ACTIVE' &&
    !result.media &&
    Boolean(result.message.textContent);

  if (needsAiHandoff) {
    await scheduleAiDebounce({ businessId, whatsappAccountId, chatId: result.chat.id });
  }
}

/**
 * Centralized "which agent, given what context, says what" decision - see
 * src/services/ai/aiOrchestrator.ts - plus every real side effect that
 * follows it (notifications, ai_mode transitions, realtime events, the
 * outbound send). Shared by both AI-handoff entry points: an immediate
 * text-only trigger from processJob, and a deferred trigger from
 * processMediaDownload once a media message's real bytes are ready (or have
 * definitively failed to download).
 */
async function runAiHandoff(params: {
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
  contactId: string | null;
  messageId: string;
  queryText: string;
  mediaId: string | null;
}): Promise<void> {
  const { businessId, whatsappAccountId, chatId, contactId, messageId, queryText, mediaId } = params;
  let senderJid: string | undefined;

  if (contactId) {
    // ── Operator Mode check ─────────────────────────────────────────────────
    // If the sender is the registered operator, route to the operator command
    // handler instead of the customer AI. Tenant-locked: businessId comes from
    // the authenticated job context, never from the message payload itself.
    const { rows: jidRows } = await pool.query<{ whatsapp_jid: string }>(
      `SELECT whatsapp_jid FROM whatsapp_contacts WHERE id = $1 AND business_id = $2`,
      [contactId, businessId],
    );
    senderJid = jidRows[0]?.whatsapp_jid;

    // Check WA setup wizard FIRST: this works even before operator mode is configured,
    // so the sender JID doesn't need to be the registered operator yet.
    if (senderJid && (await operatorCommandService.isWaSetupMessage(businessId, senderJid, queryText))) {
      const { reply } = await operatorCommandService.handleWaSetup(businessId, senderJid, queryText);
      try {
        await whatsappOutboundMessageService.send({
          businessId,
          whatsappAccountId,
          chatId,
          idempotencyKey: `operator-setup-wa:${messageId}`,
          messageType: 'text',
          text: reply,
          requestedBy: 'ai',
        });
      } catch (err) {
        console.error('[IncomingMessagesWorker] WA setup reply failed to send:', err instanceof Error ? err.message : err);
      }
      return;
    }

    if (senderJid && (await operatorCommandService.isOperatorMessage(businessId, senderJid))) {
      const { reply } = await operatorCommandService.handle(businessId, senderJid, queryText);
      try {
        await whatsappOutboundMessageService.send({
          businessId,
          whatsappAccountId,
          chatId,
          idempotencyKey: `operator-reply:${messageId}`,
          messageType: 'text',
          text: reply,
          requestedBy: 'ai',
        });
      } catch (err) {
        console.error('[IncomingMessagesWorker] Operator reply failed to send:', err instanceof Error ? err.message : err);
      }
      return;
    }

    const crmContact = await crmContactRepository.findByWhatsAppContact(businessId, contactId);
    if (crmContact?.aiExcluded) {
      console.log(`[IncomingMessagesWorker] Chat ${chatId}: AI excluded for contact ${contactId}, skipping AI reply`);
      return;
    }
  }

  // ── Property maintenance triage (P3) ────────────────────────────────────
  // A chat an operator has bound to a property (propertyConversationBindingRouter)
  // runs the full WhatsApp -> triage -> ActionRequest -> approval -> work
  // order -> audit loop before the generic AI reply, not instead of it: a
  // chat with no binding, or with the skill disabled, falls straight through
  // to orchestrateAiReply below unchanged. See propertyMaintenanceOrchestrator.ts.
  try {
    const maintenance = await runPropertyMaintenanceHandoff({
      businessId,
      chatId,
      conversationAddress: senderJid ?? contactId ?? 'unknown',
      queryText,
    });
    if (maintenance.kind === 'handled') {
      const fallbackText = 'Thanks for letting us know — I’ve flagged this for our team and they’ll follow up shortly.';
      try {
        await whatsappOutboundMessageService.send({
          businessId,
          whatsappAccountId,
          chatId,
          idempotencyKey: `property-maintenance-reply:${messageId}`,
          messageType: 'text',
          text: maintenance.replyText ?? fallbackText,
          requestedBy: 'ai',
        });
      } catch (err) {
        console.error('[IncomingMessagesWorker] Property maintenance reply failed to send:', err instanceof Error ? err.message : err);
      }
      return;
    }
  } catch (err) {
    console.error('[IncomingMessagesWorker] Property maintenance handoff failed, falling back to generic AI reply:', err instanceof Error ? err.message : err);
  }

  const outcome = await orchestrateAiReply({ businessId, chatId, contactId, queryText, mediaId });

  // 'no_agent' is an honest, legitimate outcome (a business can
  // deliberately want AI to only ever answer specific keyword-scoped
  // topics) - it must never be papered over with a fabricated reply. But
  // it must also never be SILENT: previously this returned with nothing
  // but a server log line the business would never see, so a customer
  // could go completely unanswered, indefinitely, with no one aware of it.
  // Handled exactly like a blocked keyword now - the chat moves to
  // HUMAN_TAKEOVER (so this does not repeat silently on every subsequent
  // message from the same customer) and the business is notified.
  if (outcome.kind === 'no_agent') {
    console.log(`[IncomingMessagesWorker] Chat ${chatId}: ${outcome.reason}`);
    await chatRepository.setAiMode(chatId, 'HUMAN_TAKEOVER', 'no_agent');
    await publishRealtimeEvent({ type: 'chat.updated', businessId, chatId });
    await notifyBusiness({
      businessId,
      type: 'HUMAN_HANDOFF',
      severity: 'warning',
      title: 'A conversation needs a human',
      body: 'No AI agent matched this message (no active agent, or none of your agents\' keywords matched), so nothing was sent.',
      targetType: 'chat',
      targetId: chatId,
    }).catch((error) => {
      console.error('[IncomingMessagesWorker] Failed to dispatch HUMAN_HANDOFF notification:', error);
    });
    return;
  }

  // A blocked keyword is a hard stop: no AI reply at all. The chat is moved
  // to HUMAN_TAKEOVER so the AI cannot pick it back up on the next message,
  // and the team is notified - silently dropping it would leave a real
  // customer waiting on a reply that never comes.
  if (outcome.kind === 'escalate_to_human') {
    console.warn(`[IncomingMessagesWorker] Chat ${chatId}: ${outcome.reason}`);
    await chatRepository.setAiMode(chatId, 'HUMAN_TAKEOVER', 'blocked_keyword');
    await publishRealtimeEvent({ type: 'chat.updated', businessId, chatId });
    await notifyBusiness({
      businessId,
      type: 'HUMAN_HANDOFF',
      severity: 'warning',
      title: 'A conversation needs a human',
      body: `A blocked keyword ("${outcome.matchedKeyword}") matched, so no AI reply was sent.`,
      targetType: 'chat',
      targetId: chatId,
    }).catch((error) => {
      console.error('[IncomingMessagesWorker] Failed to dispatch HUMAN_HANDOFF notification:', error);
    });
    return;
  }

  // Same observability gap as 'no_agent' above, one step further down the
  // pipeline: an agent WAS selected, but the model call itself failed
  // (bad/missing API key, quota, a genuine API error) and Goose failover
  // (plus the orchestrator's own one-hop escalation) didn't save it.
  // Previously this was silent too - only a server log line - so a
  // business could have a perfectly configured agent and still see
  // nothing arrive, indefinitely, with no clue why. outcome.reason
  // carries the real, specific cause (e.g. "GEMINI_API_KEY is not
  // configured" or the literal API error) into the notification, so the
  // operator does not have to guess.
  if (outcome.kind === 'unavailable') {
    console.log(`[IncomingMessagesWorker] AI reply unavailable for chat ${chatId}: ${outcome.reason}`);
    await chatRepository.setAiMode(chatId, 'HUMAN_TAKEOVER', 'ai_unavailable');
    await publishRealtimeEvent({ type: 'chat.updated', businessId, chatId });
    await notifyBusiness({
      businessId,
      type: 'AI_FAILURE',
      severity: 'warning',
      title: 'The AI could not reply to a conversation',
      body: outcome.reason,
      targetType: 'chat',
      targetId: chatId,
    }).catch((error) => {
      console.error('[IncomingMessagesWorker] Failed to dispatch AI_FAILURE notification:', error);
    });
    return;
  }

  const agent = outcome.agent;

  // Idempotency key derived from the inbound message's own id: if this job
  // is ever retried/redelivered, the exact same reply is never sent twice.
  //
  // Phase 3B fix: the reply text was already successfully generated above
  // (a real Gemini/Goose call) by the time this runs - a failure here is
  // about *delivery*, not generation. Previously unguarded, so a thrown
  // error (e.g. a transient DB error on the insert) would propagate out of
  // processJob and cause BullMQ to retry the *whole* incoming_messages job.
  // Sentinel screening and message persistence are idempotent, so that part
  // of a retry is safe, but it would also silently re-run AI generation -
  // a second real Gemini/Goose call for a failure that had nothing to do
  // with AI at all (see docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md
  // section 1/2.6). Caught and logged instead: never rethrown.
  try {
    await whatsappOutboundMessageService.send({
      businessId,
      whatsappAccountId,
      chatId,
      idempotencyKey: `ai-reply:${messageId}`,
      messageType: 'text',
      text: outcome.text,
      requestedBy: 'ai',
      // The operator's real configured pacing, so replies do not land
      // unnaturally fast. 0 dispatches immediately.
      ...(agent.responseDelaySeconds > 0 ? { delayMs: agent.responseDelaySeconds * 1000 } : {}),
    });
    console.log(`[IncomingMessagesWorker] AI reply queued for chat ${chatId} (agent ${agent.id}).`);
  } catch (error) {
    console.error(
      `[IncomingMessagesWorker] AI reply was generated but failed to send for chat ${chatId} (not retrying generation):`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * The media-message counterpart to the inline trigger above: called once
 * per media job, after its real download outcome (success, failure, or
 * unavailable) is already durably recorded. Never fires for a message a
 * human sent, one from before this account was live, one whose chat isn't
 * AI_ACTIVE right now, or a duplicate/backfilled row - the same real
 * conditions the text-only path checks, just evaluated after the async
 * download instead of at persist time.
 */
async function maybeTriggerMediaAiHandoff(
  message: WhatsAppMessageRecord,
  media: WhatsAppMediaRecord,
): Promise<void> {
  if (message.fromMe || message.isHistorical) return;

  const chat = await chatRepository.findByIdForBusiness(message.chatId, message.businessId);
  if (!chat || chat.aiMode !== 'AI_ACTIVE') return;

  const mediaAvailable = media.downloadStatus === 'downloaded';
  const queryText = message.textContent ?? mediaFallbackText(message.messageType, mediaAvailable);

  await runAiHandoff({
    businessId: message.businessId,
    whatsappAccountId: message.whatsappAccountId,
    chatId: chat.id,
    contactId: chat.contactId,
    messageId: message.id,
    queryText,
    mediaId: mediaAvailable ? media.id : null,
  });
}

const messageRepository = new WhatsAppMessageRepository(pool);
const callRepository = new WhatsAppCallRepository(pool);
const syncJobRepository = new WhatsAppSyncJobRepository(pool);
const accountRepository = new WhatsAppAccountRepository(pool);
const mediaRepository = new WhatsAppMediaRepository(pool);
const reactionRepository = new WhatsAppMessageReactionRepository(pool);
const presenceRepository = new WhatsAppPresenceRepository(pool);
const outboundMessageRepository = new WhatsAppOutboundMessageRepository(pool);
const emailMessageRepository = new EmailMessageRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);
const crmContactRepository = new CrmContactRepository(pool);
const operatorCommandService = new OperatorCommandService(pool);

// Configurable, not hardcoded: operators can raise/lower this per deployment.
const MAX_MEDIA_DOWNLOAD_BYTES = Number(process.env.MEDIA_MAX_DOWNLOAD_BYTES ?? 100 * 1024 * 1024);

const MEDIA_CONTENT_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

/** Pulls the sender-declared plaintext SHA-256 off whichever media field is present, for real integrity verification against the bytes we actually downloaded. */
function extractDeclaredSha256(message: proto.IMessage): Buffer | null {
  for (const key of MEDIA_CONTENT_KEYS) {
    const content = message[key];
    if (content?.fileSha256) return Buffer.from(content.fileSha256);
  }
  return null;
}

interface HttpLikeError {
  status?: number;
  output?: { statusCode?: number };
}

/**
 * A checksum mismatch could be transient corruption in transit, but a
 * *repeated* mismatch strongly suggests a real integrity problem - capped
 * at one retry (never the full general budget) regardless of
 * MEDIA_DOWNLOAD_MAX_ATTEMPTS, per PHASE_2A proposal section 3. Never
 * higher than the general cap either, in case an operator sets that below 2.
 */
const MAX_CHECKSUM_MISMATCH_ATTEMPTS = Math.min(2, MEDIA_DOWNLOAD_MAX_ATTEMPTS);

type MediaDownloadOutcome =
  | { kind: 'success'; storageReference: string; sha256Hex: string; fileSize: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'terminal'; category: MediaDownloadErrorCategory; message: string }
  | { kind: 'retryable'; category: MediaDownloadErrorCategory; message: string; maxAttempts: number };

/**
 * Attempts one real download+verify+store of the media bytes and classifies
 * the outcome per PHASE_2A proposal section 3's retryable/terminal
 * taxonomy. Never writes to the database itself - the caller (
 * processMediaDownload) owns every state transition via the guarded
 * repository methods, so this function can be a pure "what happened"
 * classifier.
 */
async function attemptMediaDownload(
  businessId: string,
  mediaId: string,
  waMessage: WAMessage,
  declaredSha256: Buffer | null,
): Promise<MediaDownloadOutcome> {
  try {
    const buffer = await downloadMediaMessage(waMessage, 'buffer', {});
    if (!buffer || buffer.length === 0) {
      return {
        kind: 'retryable',
        category: 'network',
        message: 'Download returned an empty buffer',
        maxAttempts: MEDIA_DOWNLOAD_MAX_ATTEMPTS,
      };
    }
    if (buffer.length > MAX_MEDIA_DOWNLOAD_BYTES) {
      return {
        kind: 'terminal',
        category: 'oversized',
        message: `Media (${buffer.length} bytes) exceeds MEDIA_MAX_DOWNLOAD_BYTES (${MAX_MEDIA_DOWNLOAD_BYTES}) - will not become smaller on retry`,
      };
    }
    const actualSha256 = createHash('sha256').update(buffer).digest();
    if (declaredSha256 && !actualSha256.equals(declaredSha256)) {
      return {
        kind: 'retryable',
        category: 'checksum_mismatch',
        message: 'Downloaded bytes failed checksum verification against sender-declared SHA-256',
        maxAttempts: MAX_CHECKSUM_MISMATCH_ATTEMPTS,
      };
    }
    const sha256Hex = actualSha256.toString('hex');
    const storageReference = await storeMedia(businessId, sha256Hex, buffer);
    return { kind: 'success', storageReference, sha256Hex, fileSize: buffer.length };
  } catch (error) {
    const httpError = error as HttpLikeError;
    const statusCode = httpError.output?.statusCode ?? httpError.status;
    if (statusCode === 404 || statusCode === 410) {
      return { kind: 'unavailable', message: `Media expired on WhatsApp's CDN (HTTP ${statusCode})` };
    }
    return {
      kind: 'retryable',
      category: 'network',
      message: (error as Error).message || 'Unknown download error',
      maxAttempts: MEDIA_DOWNLOAD_MAX_ATTEMPTS,
    };
  }
}

/**
 * Shared terminal-outcome follow-up (success, failed, or unavailable):
 * publishes the realtime update and, for message media, evaluates the
 * deferred AI handoff. Deliberately NOT called on a retry_scheduled
 * transition - firing the AI handoff while a retry is still pending would
 * mean the AI answers "I can't see the media" on attempt 1 even though
 * attempt 2 might still succeed. Only a real, final outcome reaches this.
 */
async function publishMediaOutcome(businessId: string, mediaId: string): Promise<void> {
  const media = await mediaRepository.findByIdForBusiness(mediaId, businessId);
  if (media?.messageId) {
    const message = await messageRepository.findByIdForBusiness(media.messageId, businessId);
    if (message) {
      await publishRealtimeEvent({ type: 'media.updated', businessId, mediaId, messageId: message.id, chatId: message.chatId });
      await maybeTriggerMediaAiHandoff(message, media);
    }
  } else if (media?.statusId) {
    await publishRealtimeEvent({ type: 'status.media.updated', businessId, mediaId, statusId: media.statusId });
  }
}

/**
 * Downloads the real media bytes for a message via Baileys' own
 * downloadMediaMessage, verifies them, encrypts-at-rest, and records an
 * honest outcome via the Phase 2B guarded state machine - never a
 * fabricated success, and never silently absorbing a failure BullMQ's own
 * attempts/backoff could otherwise recover from. See
 * docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md sections 2/3/5. No `ctx`
 * (reupload-request callback) is passed to downloadMediaMessage: this
 * worker has no live Baileys socket, so an expired-media reupload isn't
 * possible from here and is reported as UNAVAILABLE rather than faked.
 */
async function processMediaDownload(data: MediaDownloadJobData): Promise<void> {
  const { businessId, mediaId, mediaDescriptor } = data;

  // Guarded transition: a duplicate job delivery, or a job that raced the
  // crash-recovery sweep and lost, finds the row no longer in an eligible
  // starting state and no-ops here rather than re-downloading or
  // re-recording anything (PHASE_2A section 4/6).
  const { started, attempts } = await mediaRepository.beginDownloadAttempt(mediaId, ['pending', 'retry_scheduled']);
  if (!started) {
    console.log(
      `[RealtimeEventsWorker] Media ${mediaId} download attempt skipped - not in an eligible state (duplicate delivery or already resolved)`,
    );
    return;
  }

  let decoded: { key: WAMessageKey; message: proto.IMessage };
  try {
    decoded = decodeBuffersFromQueue(mediaDescriptor) as { key: WAMessageKey; message: proto.IMessage };
  } catch (error) {
    // A malformed descriptor is a programming/data bug, not a capacity
    // problem - retrying it can never succeed differently, so it fails
    // closed immediately and never consumes retry budget pretending
    // otherwise (PHASE_2A section 3's "non-HTTP-shaped error" case).
    console.error(`[RealtimeEventsWorker] Media ${mediaId} descriptor could not be decoded:`, (error as Error).message);
    await mediaRepository.failTerminally(
      mediaId,
      'failed',
      'internal',
      (error as Error).message,
      'Media job descriptor could not be decoded',
    );
    await publishMediaOutcome(businessId, mediaId);
    return;
  }

  const waMessage = { key: decoded.key, message: decoded.message } as WAMessage;
  const declaredSha256 = extractDeclaredSha256(decoded.message);
  const outcome = await attemptMediaDownload(businessId, mediaId, waMessage, declaredSha256);

  if (outcome.kind === 'success') {
    await mediaRepository.completeDownload(mediaId, outcome.storageReference, outcome.sha256Hex, outcome.fileSize);
    await publishMediaOutcome(businessId, mediaId);
    return;
  }

  if (outcome.kind === 'unavailable') {
    console.error(`[RealtimeEventsWorker] Media ${mediaId} unavailable: ${outcome.message}`);
    await mediaRepository.failTerminally(mediaId, 'unavailable', null, null, outcome.message);
    await publishMediaOutcome(businessId, mediaId);
    return;
  }

  if (outcome.kind === 'terminal') {
    console.error(`[RealtimeEventsWorker] Media ${mediaId} terminally failed (${outcome.category}): ${outcome.message}`);
    await mediaRepository.failTerminally(mediaId, 'failed', outcome.category, outcome.message, outcome.message);
    await publishMediaOutcome(businessId, mediaId);
    return;
  }

  // outcome.kind === 'retryable' from here.
  if (attempts >= outcome.maxAttempts) {
    const terminalReason = `Exhausted ${attempts} attempt(s): ${outcome.message}`;
    console.error(`[RealtimeEventsWorker] Media ${mediaId} ${terminalReason}`);
    await mediaRepository.failTerminally(mediaId, 'failed', outcome.category, outcome.message, terminalReason);
    await publishMediaOutcome(businessId, mediaId);
    return;
  }

  // Matches BullMQ's own exponential backoff formula for this job's
  // configured delay - observability only (see whatsapp_media.next_retry_at
  // in PHASE_2A section 8); BullMQ's own scheduler is the actual source of
  // truth for when the retry fires.
  const nextRetryAt = new Date(Date.now() + MEDIA_DOWNLOAD_BACKOFF_DELAY_MS * 2 ** (attempts - 1));
  const scheduled = await mediaRepository.scheduleRetry(mediaId, outcome.category, outcome.message, nextRetryAt);
  if (!scheduled) {
    // The row moved out of 'downloading' under us since beginDownloadAttempt
    // (should not happen - only this job instance holds that state - but if
    // it ever does, do not blindly throw and let BullMQ retry a row whose
    // real state has already moved on independently).
    console.warn(`[RealtimeEventsWorker] Media ${mediaId} retry scheduling skipped - row state changed concurrently`);
    return;
  }
  console.warn(
    `[RealtimeEventsWorker] Media ${mediaId} retry ${attempts}/${outcome.maxAttempts} scheduled (${outcome.category}): ${outcome.message}`,
  );

  // Throwing is what actually activates BullMQ's own attempts/backoff
  // timing (PHASE_2A section 5) - the DB write above already recorded the
  // real outcome; this is a thin signal on top of it, not a separate
  // judgment, and it is the ONLY throw in this function.
  throw new Error(`Retryable media download failure (${outcome.category}): ${outcome.message}`);
}

/**
 * Thin wrapper - the real status-persistence logic (insert, media
 * placeholder, queued download) lives in whatsappStatusPersistenceService.ts,
 * shared with the historical messaging-history.set sync path so both
 * paths route status@broadcast content into the same tested logic
 * instead of duplicating it. See docs/PHASE_1_STATUS_TEXT_FIX_PROPOSAL.md.
 */
async function processStatusUpdate(data: StatusUpdateJobData): Promise<void> {
  await persistStatusUpdate(data.businessId, data.whatsappAccountId, data.ingested);
}

/**
 * The debounce job's handler (Phase 3B, see
 * docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 5) - fired
 * after a chat has gone quiet for AI_DEBOUNCE_DELAY_MS. The job payload
 * (`data`) is deliberately treated as nothing more than a "check this chat
 * now" signal: everything this function actually acts on is re-read fresh
 * from Postgres, so a duplicate/stale/redelivered job can never cause a
 * duplicate reply and a message that arrived after the job was originally
 * scheduled is still included.
 *
 * claimAiHandoff/releaseAiHandoff (both real, guarded UPDATEs on
 * whatsapp_chats) are the actual mutex - a second concurrent invocation
 * for the same chat (a genuine duplicate delivery, or this job racing the
 * backstop sweep) finds the claim already held and safely no-ops.
 */
async function processAiDebounce(data: AiDebounceJobData): Promise<void> {
  const { businessId, whatsappAccountId, chatId } = data;

  const claimed = await chatRepository.claimAiHandoff(chatId);
  if (!claimed) return; // Not AI_ACTIVE anymore, or another invocation already holds the claim.

  let lastConsideredMessageId: string | null = null;
  try {
    const unanswered = await messageRepository.findUnansweredInboundSince(chatId, claimed.lastAiHandoffMessageId);
    if (unanswered.length === 0) return;

    lastConsideredMessageId = unanswered[unanswered.length - 1]!.id;
    const combinedText = unanswered
      .map((message) => message.textContent)
      .filter((text): text is string => Boolean(text && text.trim()))
      .join('\n');
    if (!combinedText) return; // Nothing with real text among the unanswered batch.

    await runAiHandoff({
      businessId,
      whatsappAccountId,
      chatId,
      contactId: claimed.contactId,
      messageId: lastConsideredMessageId,
      queryText: combinedText,
      mediaId: null,
    });
  } finally {
    // Always releases, even if runAiHandoff somehow throws (it is designed
    // not to, but this is the actual crash/duplicate-reply safety net, not
    // an optimization) - a claim left held would otherwise block every
    // future message in this chat until the backstop sweep's stale-claim
    // timeout eventually clears it.
    await chatRepository.releaseAiHandoff(chatId, lastConsideredMessageId);
  }
}

/**
 * Fires HUMAN_TAKEOVER_RESUME_DELAY_MS after the last manual reply detected
 * for this chat (see whatsappMessagePersistenceService.ts's detection and
 * scheduleHumanTakeoverResume's trailing-edge reset). Re-checks the real
 * chat row rather than trusting this job's payload -
 * resumeAiIfManualReplyDetected is a single guarded UPDATE that only
 * succeeds when the row is *still* exactly ('HUMAN_TAKEOVER',
 * 'manual_reply_detected'), so a chat a human explicitly re-took-over (or a
 * genuinely new AI-failure escalation) from the dashboard in the meantime
 * is never clobbered back to AI_ACTIVE by a stale timer.
 */
async function processHumanTakeoverResume(data: HumanTakeoverResumeJobData): Promise<void> {
  const resumed = await chatRepository.resumeAiIfManualReplyDetected(data.chatId);
  if (resumed) {
    await publishRealtimeEvent({ type: 'chat.updated', businessId: data.businessId, chatId: data.chatId });
  }
}

async function processMessageStatus(data: MessageStatusJobData): Promise<void> {
  const { businessId, whatsappAccountId, whatsappMessageId, status } = data;
  const message = await messageRepository.findByWhatsAppId(businessId, whatsappAccountId, whatsappMessageId);
  if (!message) return; // The message hasn't been persisted yet (or ever will be, e.g. Sentinel-blocked) - nothing to update.

  await messageRepository.updateStatus(message.id, status);
  await publishRealtimeEvent({
    type: 'message.status',
    businessId,
    chatId: message.chatId,
    messageId: message.id,
    status,
  });
}

async function processCallEvent(data: CallEventJobData): Promise<void> {
  const { businessId, whatsappAccountId, event } = data;
  const status = mapBaileysCallStatus(event.status);
  if (!status) return; // Internal WebRTC signaling noise (transport/relaylatency) - no real state change to record.

  const remoteJid = event.chatId;
  const jidKind = classifyJid(remoteJid);
  const remotePhoneNumber = jidKind === 'group' ? null : derivePhoneNumber(remoteJid, jidKind, null);

  let startedAt: string | null = null;
  let acceptedAt: string | null = null;
  let endedAt: string | null = null;
  let durationSeconds: number | null = null;

  // event.date is a real Date object when the socket handler enqueues it,
  // but BullMQ round-trips job data through JSON - by the time this worker
  // (a separate process) reads it back, it has been serialized to a string.
  const eventDate = new Date(event.date).toISOString();

  if (status === 'offer') {
    startedAt = eventDate;
  } else if (status === 'accepted') {
    acceptedAt = eventDate;
  } else if (isTerminalCallStatus(status)) {
    endedAt = eventDate;
    // Duration is real talk time (accepted -> ended), never ring time. A
    // call that was never answered (missed/rejected/timeout) has no
    // duration - inventing one from ring time would misrepresent it.
    const existing = await callRepository.findByCallId(businessId, whatsappAccountId, event.id);
    if (existing?.acceptedAt) {
      durationSeconds = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(existing.acceptedAt).getTime()) / 1000));
    }
  }

  const call = await callRepository.upsertEvent({
    businessId,
    whatsappAccountId,
    callId: event.id,
    remoteJid,
    remotePhoneNumber,
    callType: callTypeFromEvent(event.isVideo),
    direction: 'inbound', // Baileys only ever reports calls placed to this account, never ones it places.
    status,
    isVideo: Boolean(event.isVideo),
    isGroup: Boolean(event.isGroup),
    startedAt,
    acceptedAt,
    endedAt,
    durationSeconds,
  });

  await publishRealtimeEvent({ type: 'call.updated', businessId, callId: call.id });
}

/**
 * Real reaction events - Baileys' own `messages.reaction` (a dedicated
 * event, not classified via messages.upsert). `reaction.text` empty/falsy
 * means the reactor removed their reaction (Baileys' own type-declaration
 * comment on the event confirms this convention) - the row is deleted,
 * never stored with a blank reaction. The dedicated whatsapp_message_reactions
 * table is authoritative; a reaction is never also inserted into
 * whatsapp_messages.
 */
async function processReaction(data: MessageReactionJobData): Promise<void> {
  const { businessId, whatsappAccountId, accountJid, targetWhatsappMessageId, reaction } = data;

  const message = await messageRepository.findByWhatsAppId(businessId, whatsappAccountId, targetWhatsappMessageId);
  if (!message) return; // Reaction to a message we never persisted (not yet arrived, or Sentinel-blocked) - nothing real to attach it to.

  const reactorKey = reaction.key;
  const reactorJid = reactorKey?.fromMe ? accountJid : (reactorKey?.participant ?? reactorKey?.remoteJid ?? null);
  if (!reactorJid) return; // No real identity to attribute the reaction to.

  const emoji = reaction.text;
  if (emoji) {
    await reactionRepository.upsert(businessId, whatsappAccountId, message.id, reactorJid, emoji);
  } else {
    await reactionRepository.remove(message.id, reactorJid);
  }

  await publishRealtimeEvent({ type: 'message.reaction', businessId, chatId: message.chatId, messageId: message.id });
}

/**
 * Real presence.update events only - WhatsApp's actual reported states
 * ('available'/'unavailable'/'composing'/'recording'/'paused'), never
 * inferred from whether our own socket happens to be connected.
 */
async function processPresenceUpdate(data: PresenceUpdateJobData): Promise<void> {
  const { businessId, whatsappAccountId, contactJid, presence } = data;
  const lastSeenAt = presence.lastSeen ? new Date(presence.lastSeen * 1000).toISOString() : null;

  await presenceRepository.record(businessId, whatsappAccountId, contactJid, presence.lastKnownPresence, lastSeenAt);
  await publishRealtimeEvent({ type: 'presence.updated', businessId, contactJid });
}

// Documented rule: WhatsApp's own client rings for roughly 45-60s before a
// call goes to "missed" on the device. A call still sitting in offer/ringing
// well past that, with no further event ever arriving from Baileys, is
// reconciled to 'timeout' rather than left stuck forever.
const CALL_RING_TIMEOUT_SECONDS = 60;
const CALL_TIMEOUT_SWEEP_INTERVAL_MS = 30_000;

export async function sweepStaleRingingCalls(): Promise<void> {
  const stale = await callRepository.findStaleRingingCalls(CALL_RING_TIMEOUT_SECONDS);
  for (const call of stale) {
    const updated = await callRepository.upsertEvent({
      businessId: call.businessId,
      whatsappAccountId: call.whatsappAccountId,
      callId: call.callId,
      remoteJid: call.remoteJid,
      remotePhoneNumber: call.remotePhoneNumber,
      callType: call.callType,
      direction: call.direction,
      status: 'timeout',
      isVideo: call.isVideo,
      isGroup: call.isGroup,
      endedAt: new Date().toISOString(),
    });
    await publishRealtimeEvent({ type: 'call.updated', businessId: call.businessId, callId: updated.id });
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale ringing call(s) to timeout`);
  }
}

// Long enough that a real in-flight download (network-bound, can
// legitimately take a while for a large file) is never mistaken for stuck;
// short enough that a genuine crash is caught promptly. See
// sweepStaleDownloadingMedia below for why this always reconciles to
// 'failed', never a scheduled retry.
const MEDIA_DOWNLOAD_STALE_SECONDS = 300;
const MEDIA_DOWNLOAD_TIMEOUT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Crash-recovery sweep (PHASE_2A proposal sections 4/6): finds
 * whatsapp_media rows left in 'downloading' with no progress for
 * MEDIA_DOWNLOAD_STALE_SECONDS - a worker process died mid-download before
 * it could record any outcome, so nothing else will ever transition that
 * row again on its own.
 *
 * This always reconciles straight to 'failed', never 'retry_scheduled':
 * the raw Baileys media descriptor (mediaKey, CDN URL, etc.) exists only in
 * the original BullMQ job's payload - it is never persisted to Postgres (a
 * deliberate choice; it is sensitive, single-use decryption material, and
 * persisting it would be a separate security decision this phase does not
 * make). A row recovered here has no way to be automatically re-downloaded,
 * so promising a future automatic retry would be dishonest - this matches
 * the existing sweepStaleOutboundMessages precedent below (reconciles
 * directly to a terminal state, never a promise of automatic resumption).
 * BullMQ's own stalled-job redelivery (a separate, existing mechanism this
 * phase relies on rather than duplicates - PHASE_2A section 6) is the real
 * first line of defense for a same-process crash where Redis survives; this
 * sweep is what guarantees a row is never left silently claiming to be
 * in-progress forever even when that does not recover it.
 */
export async function sweepStaleDownloadingMedia(): Promise<void> {
  const stale = await mediaRepository.findStaleDownloading(MEDIA_DOWNLOAD_STALE_SECONDS);
  for (const media of stale) {
    const reason = `Worker crash or restart interrupted this download - no progress for over ${MEDIA_DOWNLOAD_STALE_SECONDS}s, reconciled by the stale-download sweep. The original download cannot be automatically resumed; a fresh message/status sync is required.`;
    const recovered = await mediaRepository.failTerminally(media.id, 'failed', 'internal', reason, reason);
    if (recovered) {
      await publishMediaOutcome(media.businessId, media.id).catch((error: Error) => {
        console.error(`[RealtimeEventsWorker] Failed to publish stale-download outcome for media ${media.id}:`, error.message);
      });
    }
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale downloading media row(s) to failed`);
  }
}

// Generous relative to how long a real claimAiHandoff->runAiHandoff round
// should ever take (a Gemini/Goose call plus an outbound-send insert) -
// this exists purely to recover from a worker dying mid-handoff, not to
// bound normal latency.
const AI_HANDOFF_CLAIM_STALE_SECONDS = 300;
const AI_HANDOFF_SWEEP_INTERVAL_MS = 60_000;

/**
 * Backstop for the Phase 3B AI debounce mechanism (see
 * docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 5): two real
 * gaps neither the debounce job nor its own claim/release guard can close
 * on their own -
 *
 * 1. A worker process dies between claimAiHandoff and releaseAiHandoff,
 *    leaving the claim held forever with no job left to release it.
 * 2. A new message arrives for a chat while its debounce jobId is still
 *    active/waiting, so scheduleAiDebounce's own attempt to (re)schedule
 *    is a safe no-op (see its own doc comment) - correct in the moment,
 *    but nothing else would ever re-arm a debounce job for that leftover
 *    message once the busy jobId frees up.
 *
 * Both converge on the same fix: clear any stale claim, then re-arm
 * scheduleAiDebounce for every AI_ACTIVE chat that still has a real
 * unanswered message - which is itself a safe, idempotent no-op for a
 * chat that is already fine.
 */
export async function sweepStaleAiHandoff(): Promise<void> {
  const released = await chatRepository.releaseStaleAiHandoffClaims(AI_HANDOFF_CLAIM_STALE_SECONDS);
  if (released.length > 0) {
    console.log(`[RealtimeEventsWorker] Released ${released.length} stale AI-handoff claim(s)`);
  }

  const pending = await chatRepository.findAiActiveChatsWithUnansweredMessages();
  for (const chat of pending) {
    await scheduleAiDebounce({ businessId: chat.businessId, whatsappAccountId: chat.whatsappAccountId, chatId: chat.id }).catch(
      (error: Error) => {
        console.error(`[RealtimeEventsWorker] Failed to re-arm AI debounce for chat ${chat.id}:`, error.message);
      },
    );
  }
  if (pending.length > 0) {
    console.log(`[RealtimeEventsWorker] Re-armed AI debounce for ${pending.length} chat(s) with unanswered messages`);
  }
}

// Documented rule: incrementCounts() bumps updated_at on every real batch of
// sync progress. A 'running' job with no progress in this long has no
// process left driving it - WhatsApp will never send it a completion signal
// on its own - reconciled to 'failed' (never 'completed'/'partial', which
// would falsely claim the sync actually finished) rather than left silently
// claiming to be in-progress forever.
const SYNC_JOB_STALE_SECONDS = 600;
const SYNC_JOB_TIMEOUT_SWEEP_INTERVAL_MS = 120_000;

export async function sweepStaleSyncJobs(): Promise<void> {
  const stale = await syncJobRepository.findStaleRunning(SYNC_JOB_STALE_SECONDS);
  for (const job of stale) {
    await syncJobRepository.markFailed(
      job.id,
      `Abandoned mid-sync - no progress for over ${SYNC_JOB_STALE_SECONDS}s (likely a process restart or crash), reconciled by the stale-job sweep`,
    );
    // Setting the account back off 'in_progress' is what lets the next
    // real reconnect retry the sync instead of the gate in
    // persistConnectedAccount() silently skipping it forever.
    await accountRepository.markSyncFailed(
      job.whatsappAccountId,
      'Sync job abandoned mid-run - will retry automatically on next reconnect',
    );
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale running sync job(s) to failed`);
  }
}

// A row wedged in 'queued'/'sending' with no BullMQ retry left to resolve it
// (worker crashed mid-dispatch, process killed between markSending and the
// actual sendMessage call) - the same honesty problem the call/sync-job
// sweeps exist for, reconciled the same way: never left silently claiming
// to be in-flight forever.
const OUTBOUND_MESSAGE_STALE_SECONDS = 300;
const OUTBOUND_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS = 60_000;

export async function sweepStaleOutboundMessages(): Promise<void> {
  const stale = await outboundMessageRepository.findStalePending(OUTBOUND_MESSAGE_STALE_SECONDS);
  for (const record of stale) {
    await outboundMessageRepository.markFailed(
      record.id,
      `Abandoned mid-send - no progress for over ${OUTBOUND_MESSAGE_STALE_SECONDS}s (likely a process restart or crash), reconciled by the stale-message sweep`,
    );
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale outbound message(s) to failed`);
  }
}

// Same honesty problem as the outbound-message sweep above, but a genuinely
// different outcome: markSending() on email_messages only ever re-claims a
// row that is 'approved', so a stuck 'sending' row has no BullMQ retry
// waiting to resolve it, and whether the provider actually sent it is
// unknown - reconciled to 'indeterminate' (never a false 'failed') and
// surfaced to the business so a human checks the real mailbox/provider.
const EMAIL_STALE_SECONDS = 300;
const EMAIL_TIMEOUT_SWEEP_INTERVAL_MS = 60_000;

// A WAITING funnel instance can legitimately stay WAITING for days (a
// WAIT node's own configured delay) - see sweepStaleFunnelInstances in
// funnelService.ts for why this sweep checks a much longer interval than
// the others above, at a coarser cadence to match.
const FUNNEL_INSTANCE_TIMEOUT_SWEEP_INTERVAL_MS = 300_000;

// Phase 18 of the original directive - real, scheduled security scans
// over the existing security_audit_logs table (see securityScanService.ts).
// Hourly is frequent enough that a genuine brute-force/probing pattern is
// caught within an hour of crossing its threshold, without the cost of
// re-scanning the full window every minute.
const SECURITY_SCAN_INTERVAL_MS = 3_600_000;

// OpenClaw Security Watcher - polls GitHub Security Advisories for the
// exact OpenClaw version(s) this platform has deployed (see
// openclawSecurityWatcherService.ts). No tenant has an OpenClaw
// cell provisioned yet as of this phase (cell provisioning wiring is a
// later slice), so this job runs and correctly no-ops until one exists -
// it is registered now rather than added later so there is no window
// where a deployed cell exists without a watcher checking it. Every 6
// hours: advisories don't change fast enough to need hourly polling, and
// this keeps well under GitHub's unauthenticated rate limit for however
// many distinct versions are ever actually deployed.
const OPENCLAW_SECURITY_WATCHER_INTERVAL_MS = 21_600_000;

export async function sweepStaleEmails(): Promise<void> {
  const stale = await emailMessageRepository.findStalePending(EMAIL_STALE_SECONDS);
  for (const email of stale) {
    const reason = `Abandoned mid-send - no progress for over ${EMAIL_STALE_SECONDS}s (likely a process restart or crash); whether the provider actually sent it is unknown`;
    await emailMessageRepository.markIndeterminate(email.id, reason);
    await notifyBusiness({
      businessId: email.businessId,
      type: 'AUTOMATION_FAILURE',
      severity: 'warning',
      title: 'An email send needs a manual check',
      body: `A send to ${email.toEmail} was interrupted and we cannot confirm whether it reached the provider. Check before resending.`,
      targetType: 'email_message',
      targetId: email.id,
    }).catch((error) => {
      console.error('[RealtimeEventsWorker] Failed to dispatch AUTOMATION_FAILURE notification:', error);
    });
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale email(s) to indeterminate`);
  }
}

async function processRealtimeEventJob(
  job: Job<
    | MessageStatusJobData
    | CallEventJobData
    | StatusUpdateJobData
    | MediaDownloadJobData
    | MessageReactionJobData
    | PresenceUpdateJobData
    | AiDebounceJobData
    | HumanTakeoverResumeJobData
  >,
): Promise<void> {
  if (job.name === 'message-status') {
    await processMessageStatus(job.data as MessageStatusJobData);
  } else if (job.name === 'call-event') {
    await processCallEvent(job.data as CallEventJobData);
  } else if (job.name === 'status-update') {
    await processStatusUpdate(job.data as StatusUpdateJobData);
  } else if (job.name === 'call-timeout-sweep') {
    await sweepStaleRingingCalls();
  } else if (job.name === 'sync-job-timeout-sweep') {
    await sweepStaleSyncJobs();
  } else if (job.name === 'media-download-timeout-sweep') {
    await sweepStaleDownloadingMedia();
  } else if (job.name === 'ai-handoff-sweep') {
    await sweepStaleAiHandoff();
  } else if (job.name === 'ai-debounce') {
    await processAiDebounce(job.data as AiDebounceJobData);
  } else if (job.name === 'human-takeover-resume') {
    await processHumanTakeoverResume(job.data as HumanTakeoverResumeJobData);
  } else if (job.name === 'outbound-message-timeout-sweep') {
    await sweepStaleOutboundMessages();
  } else if (job.name === 'email-timeout-sweep') {
    await sweepStaleEmails();
  } else if (job.name === 'funnel-instance-timeout-sweep') {
    await sweepStaleFunnelInstances();
  } else if (job.name === 'security-scan') {
    await runSecurityScan();
  } else if (job.name === 'openclaw-security-watcher') {
    await runSecurityWatcher();
  } else if (job.name === 'media-download') {
    await processMediaDownload(job.data as MediaDownloadJobData);
  } else if (job.name === 'message-reaction') {
    await processReaction(job.data as MessageReactionJobData);
  } else if (job.name === 'presence-update') {
    await processPresenceUpdate(job.data as PresenceUpdateJobData);
  }
}

const CONCURRENCY = Number(process.env.INCOMING_MESSAGES_WORKER_CONCURRENCY ?? 5);

export const incomingMessagesWorker = new Worker<IncomingMessageJobData>(INCOMING_MESSAGES_QUEUE, processJob, {
  connection: queueConnection,
  concurrency: CONCURRENCY,
});

export const realtimeEventsWorker = new Worker(REALTIME_EVENTS_QUEUE, processRealtimeEventJob, {
  connection: queueConnection,
  concurrency: CONCURRENCY,
});

// This is the process that actually calls generateAiReply, so it needs its
// own background time calibration too - fire-and-forget, never blocks
// worker startup or message processing.
timeService.start();

incomingMessagesWorker.on('completed', (job) => {
  console.log(`[IncomingMessagesWorker] Persisted message ${job.data.message.messageId}`);
});

incomingMessagesWorker.on('failed', (job, error) => {
  console.error(`[IncomingMessagesWorker] Failed to persist message ${job?.data.message.messageId}:`, error.message);
});

incomingMessagesWorker.on('error', (error) => {
  console.error('[IncomingMessagesWorker] Worker error:', error.message);
});

realtimeEventsWorker.on('failed', (job, error) => {
  console.error(`[RealtimeEventsWorker] Failed job "${job?.name}":`, error.message);
});

realtimeEventsWorker.on('error', (error) => {
  console.error('[RealtimeEventsWorker] Worker error:', error.message);
});

async function closeWorkers(): Promise<void> {
  await Promise.all([incomingMessagesWorker.close(), realtimeEventsWorker.close(), documentParseWorker.close()]);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[IncomingMessagesWorker] Received ${signal}, closing workers...`);
  await closeWorkers();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// See src/process/crashSafety.ts - catches exactly the class of crash a
// mid-transfer network drop (a laptop waking from standby, an ISP blip)
// can trigger via Baileys' own unguarded media-download stream pipe, so
// it degrades to a clean, logged, recoverable exit instead of a silent
// process death with nothing left to restart it.
installCrashSafetyHandlers('IncomingMessagesWorker', closeWorkers);

console.log(`[IncomingMessagesWorker] Listening on queue "${INCOMING_MESSAGES_QUEUE}" (concurrency=${CONCURRENCY})`);
console.log(`[RealtimeEventsWorker] Listening on queue "${REALTIME_EVENTS_QUEUE}" (concurrency=${CONCURRENCY})`);

// upsertJobScheduler is idempotent by scheduler id, so re-registering this on
// every worker restart is safe and never creates duplicate schedules.
void realtimeEventsQueue
  .upsertJobScheduler('call-timeout-sweep', { every: CALL_TIMEOUT_SWEEP_INTERVAL_MS }, { name: 'call-timeout-sweep' })
  .then(() => console.log(`[RealtimeEventsWorker] Scheduled call-timeout-sweep every ${CALL_TIMEOUT_SWEEP_INTERVAL_MS}ms`))
  .catch((error: Error) => console.error('[RealtimeEventsWorker] Failed to schedule call-timeout-sweep:', error.message));

void realtimeEventsQueue
  .upsertJobScheduler(
    'sync-job-timeout-sweep',
    { every: SYNC_JOB_TIMEOUT_SWEEP_INTERVAL_MS },
    { name: 'sync-job-timeout-sweep' },
  )
  .then(() =>
    console.log(`[RealtimeEventsWorker] Scheduled sync-job-timeout-sweep every ${SYNC_JOB_TIMEOUT_SWEEP_INTERVAL_MS}ms`),
  )
  .catch((error: Error) =>
    console.error('[RealtimeEventsWorker] Failed to schedule sync-job-timeout-sweep:', error.message),
  );

void realtimeEventsQueue
  .upsertJobScheduler(
    'media-download-timeout-sweep',
    { every: MEDIA_DOWNLOAD_TIMEOUT_SWEEP_INTERVAL_MS },
    { name: 'media-download-timeout-sweep' },
  )
  .then(() =>
    console.log(
      `[RealtimeEventsWorker] Scheduled media-download-timeout-sweep every ${MEDIA_DOWNLOAD_TIMEOUT_SWEEP_INTERVAL_MS}ms`,
    ),
  )
  .catch((error: Error) =>
    console.error('[RealtimeEventsWorker] Failed to schedule media-download-timeout-sweep:', error.message),
  );

void realtimeEventsQueue
  .upsertJobScheduler('ai-handoff-sweep', { every: AI_HANDOFF_SWEEP_INTERVAL_MS }, { name: 'ai-handoff-sweep' })
  .then(() => console.log(`[RealtimeEventsWorker] Scheduled ai-handoff-sweep every ${AI_HANDOFF_SWEEP_INTERVAL_MS}ms`))
  .catch((error: Error) => console.error('[RealtimeEventsWorker] Failed to schedule ai-handoff-sweep:', error.message));

void realtimeEventsQueue
  .upsertJobScheduler(
    'outbound-message-timeout-sweep',
    { every: OUTBOUND_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS },
    { name: 'outbound-message-timeout-sweep' },
  )
  .then(() =>
    console.log(
      `[RealtimeEventsWorker] Scheduled outbound-message-timeout-sweep every ${OUTBOUND_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS}ms`,
    ),
  )
  .catch((error: Error) =>
    console.error('[RealtimeEventsWorker] Failed to schedule outbound-message-timeout-sweep:', error.message),
  );

void realtimeEventsQueue
  .upsertJobScheduler('email-timeout-sweep', { every: EMAIL_TIMEOUT_SWEEP_INTERVAL_MS }, { name: 'email-timeout-sweep' })
  .then(() => console.log(`[RealtimeEventsWorker] Scheduled email-timeout-sweep every ${EMAIL_TIMEOUT_SWEEP_INTERVAL_MS}ms`))
  .catch((error: Error) => console.error('[RealtimeEventsWorker] Failed to schedule email-timeout-sweep:', error.message));

void realtimeEventsQueue
  .upsertJobScheduler(
    'funnel-instance-timeout-sweep',
    { every: FUNNEL_INSTANCE_TIMEOUT_SWEEP_INTERVAL_MS },
    { name: 'funnel-instance-timeout-sweep' },
  )
  .then(() =>
    console.log(
      `[RealtimeEventsWorker] Scheduled funnel-instance-timeout-sweep every ${FUNNEL_INSTANCE_TIMEOUT_SWEEP_INTERVAL_MS}ms`,
    ),
  )
  .catch((error: Error) =>
    console.error('[RealtimeEventsWorker] Failed to schedule funnel-instance-timeout-sweep:', error.message),
  );

void realtimeEventsQueue
  .upsertJobScheduler('security-scan', { every: SECURITY_SCAN_INTERVAL_MS }, { name: 'security-scan' })
  .then(() => console.log(`[RealtimeEventsWorker] Scheduled security-scan every ${SECURITY_SCAN_INTERVAL_MS}ms`))
  .catch((error: Error) => console.error('[RealtimeEventsWorker] Failed to schedule security-scan:', error.message));

void realtimeEventsQueue
  .upsertJobScheduler(
    'openclaw-security-watcher',
    { every: OPENCLAW_SECURITY_WATCHER_INTERVAL_MS },
    { name: 'openclaw-security-watcher' },
  )
  .then(() =>
    console.log(`[RealtimeEventsWorker] Scheduled openclaw-security-watcher every ${OPENCLAW_SECURITY_WATCHER_INTERVAL_MS}ms`),
  )
  .catch((error: Error) => console.error('[RealtimeEventsWorker] Failed to schedule openclaw-security-watcher:', error.message));
