import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import {
  WhatsAppOutboundMessageRepository,
  type WhatsAppOutboundMessageRecord,
} from '../repositories/whatsappOutboundMessageRepository.js';
import { ConversationEventRepository } from '../repositories/conversationEventRepository.js';
import { enqueueOutboundMessage } from '../queue/queues/outboundMessagesQueue.js';
import { enqueueWithTimeout } from '../queue/enqueueWithTimeout.js';
import { storeMedia } from '../media/mediaStorage.js';
import { transcodeToVoiceNote } from '../media/audioTranscodeService.js';
import type { OutboundMessageType } from '../domain/whatsapp/types.js';

export interface ChatNotFoundError extends Error {
  code: 'CHAT_NOT_FOUND';
}

export function isChatNotFoundError(error: unknown): error is ChatNotFoundError {
  return error instanceof Error && (error as ChatNotFoundError).code === 'CHAT_NOT_FOUND';
}

export interface SendOutboundMessageInput {
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
  idempotencyKey?: string;
  messageType: OutboundMessageType;
  text?: string;
  caption?: string;
  /** Base64-encoded raw file bytes. Required for every messageType except 'text', unless mediaStorageReference is supplied directly instead. */
  mediaBase64?: string;
  /**
   * A reference already returned by a prior storeMedia() call - bypasses
   * the decode/hash/store step entirely. The one real caller: campaignService.ts's
   * sendCampaign(), which stores a campaign's attachment exactly once and
   * reuses this same reference for every recipient, rather than
   * re-decoding and re-hashing the identical bytes on every one of
   * potentially 100 real sends.
   */
  mediaStorageReference?: string | undefined;
  mediaMimeType?: string | undefined;
  mediaFileName?: string | undefined;
  /** Defaults to 'human' when omitted - set explicitly to 'ai' by the AI reply pipeline. */
  requestedBy?: string;
  /** Staggers real dispatch (BullMQ job delay) - set by campaign sends, never by a normal composer send. */
  delayMs?: number;
}

/** WhatsApp's own outbound media ceiling is well above this - kept conservative for a v1 base64-JSON upload path. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export class WhatsAppOutboundMessageService {
  private readonly chatRepository = new WhatsAppChatRepository(pool);
  private readonly outboundMessageRepository = new WhatsAppOutboundMessageRepository(pool);
  private readonly conversationEventRepository = new ConversationEventRepository(pool);

  /**
   * The one entry point for sending an outbound WhatsApp message, whether
   * requested by a human agent (the composer's explicit API call) or the AI
   * reply pipeline (requestedBy: 'ai'). Idempotency-safe: a retried request
   * with the same key (client-supplied, or generated once and required on
   * retry) always returns the one real send request, never enqueues a second.
   */
  async send(input: SendOutboundMessageInput): Promise<WhatsAppOutboundMessageRecord> {
    const chat = await this.chatRepository.findByIdForBusiness(input.chatId, input.businessId);
    if (!chat || chat.whatsappAccountId !== input.whatsappAccountId) {
      const error = new Error('Chat not found for this business.') as ChatNotFoundError;
      error.code = 'CHAT_NOT_FOUND';
      throw error;
    }

    let mediaStorageReference: string | null = null;
    let mediaMimeType = input.mediaMimeType;
    let mediaDurationSeconds: number | null = null;

    if (input.messageType !== 'text') {
      if (input.mediaStorageReference) {
        mediaStorageReference = input.mediaStorageReference;
      } else {
        if (!input.mediaBase64) throw new Error(`messageType "${input.messageType}" requires mediaBase64 or mediaStorageReference`);
        let buffer = Buffer.from(input.mediaBase64, 'base64');
        if (buffer.length === 0) throw new Error('Decoded media is empty');
        if (buffer.length > MAX_MEDIA_BYTES) {
          throw new Error(`Media exceeds the ${MAX_MEDIA_BYTES} byte limit`);
        }

        /*
         * A voice note is converted to Ogg/Opus BEFORE the row exists, so an
         * unplayable voice note can never be persisted or queued. Browsers
         * record WebM/Opus (Chrome, Android) or MP4/AAC (Safari); WhatsApp
         * voice notes are Ogg/Opus, and sending anything else uploads happily
         * and then fails to play for the recipient. Failing loudly here is the
         * honest outcome - the alternative is a feature that looks like it
         * works and silently does not.
         */
        if (input.messageType === 'voice_note') {
          const converted = await transcodeToVoiceNote(buffer);
          if (converted.status === 'failed') throw new Error(converted.reason);
          buffer = converted.buffer;
          mediaMimeType = converted.mimeType;
          mediaDurationSeconds = converted.durationSeconds;
        }

        const sha256Hex = createHash('sha256').update(buffer).digest('hex');
        mediaStorageReference = await storeMedia(input.businessId, sha256Hex, buffer);
      }
    } else if (!input.text?.trim()) {
      throw new Error('messageType "text" requires non-empty text');
    }

    const record = await this.outboundMessageRepository.createIdempotent({
      businessId: input.businessId,
      whatsappAccountId: input.whatsappAccountId,
      chatId: chat.id,
      toJid: chat.chatJid,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      messageType: input.messageType,
      textContent: input.messageType === 'text' ? (input.text ?? null) : null,
      caption: input.caption ?? null,
      mediaStorageReference,
      // The converted mime type for a voice note, the caller's otherwise.
      mediaMimeType: mediaMimeType ?? null,
      mediaDurationSeconds,
      mediaFileName: input.mediaFileName ?? null,
      requestedBy: input.requestedBy ?? 'human',
    });

    // Only actually enqueue on a genuinely new row - createIdempotent()
    // returning a pre-existing row (the idempotency-key conflict path)
    // means a send for this exact request was already queued/dispatched.
    // The row already durably exists as 'queued' at this point, so a slow
    // or unreachable Redis must never hang this HTTP request indefinitely
    // - see enqueueWithTimeout's own comment for why.
    if (record.wasCreated) {
      await enqueueWithTimeout(enqueueOutboundMessage({ outboundMessageId: record.id }, input.delayMs), `outbound message ${record.id}`);

      // Additive observability, not correctness-critical - awaited (so
      // callers observe a consistent end state, no race with the caller
      // returning first) but never allowed to fail a real outbound send;
      // any error is caught and logged, never rethrown. Only on a
      // genuinely new request (wasCreated), matching the guard above, so a
      // retried/idempotent send never double-records the same logical
      // message.
      try {
        await this.conversationEventRepository.append({
          businessId: input.businessId,
          chatId: chat.id,
          eventType: 'message_sent',
          payload: { outboundMessageId: record.id, messageType: record.messageType },
        });
      } catch (error) {
        console.error('[WhatsAppOutboundMessageService] Failed to append message_sent event:', error instanceof Error ? error.message : error);
      }
    }

    return record;
  }
}

export const whatsappOutboundMessageService = new WhatsAppOutboundMessageService();
