import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import {
  WhatsAppOutboundMessageRepository,
  type WhatsAppOutboundMessageRecord,
} from '../repositories/whatsappOutboundMessageRepository.js';
import { enqueueOutboundMessage } from '../queue/queues/outboundMessagesQueue.js';
import { storeMedia } from '../media/localEncryptedMediaStorage.js';
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
  /** Base64-encoded raw file bytes. Required for every messageType except 'text'. */
  mediaBase64?: string;
  mediaMimeType?: string;
  mediaFileName?: string;
}

/** WhatsApp's own outbound media ceiling is well above this - kept conservative for a v1 base64-JSON upload path. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export class WhatsAppOutboundMessageService {
  private readonly chatRepository = new WhatsAppChatRepository(pool);
  private readonly outboundMessageRepository = new WhatsAppOutboundMessageRepository(pool);

  /**
   * The one entry point for a human-initiated send. Nothing in this phase
   * gives the AI layer a path here - every call originates from an explicit
   * API request. Idempotency-safe: a retried request with the same key
   * (client-supplied, or generated once and required on retry) always
   * returns the one real send request, never enqueues a second.
   */
  async send(input: SendOutboundMessageInput): Promise<WhatsAppOutboundMessageRecord> {
    const chat = await this.chatRepository.findById(input.chatId);
    if (!chat || chat.businessId !== input.businessId || chat.whatsappAccountId !== input.whatsappAccountId) {
      const error = new Error('Chat not found for this business.') as ChatNotFoundError;
      error.code = 'CHAT_NOT_FOUND';
      throw error;
    }

    let mediaStorageReference: string | null = null;
    if (input.messageType !== 'text') {
      if (!input.mediaBase64) throw new Error(`messageType "${input.messageType}" requires mediaBase64`);
      const buffer = Buffer.from(input.mediaBase64, 'base64');
      if (buffer.length === 0) throw new Error('Decoded media is empty');
      if (buffer.length > MAX_MEDIA_BYTES) {
        throw new Error(`Media exceeds the ${MAX_MEDIA_BYTES} byte limit`);
      }
      const sha256Hex = createHash('sha256').update(buffer).digest('hex');
      mediaStorageReference = await storeMedia(input.businessId, sha256Hex, buffer);
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
      mediaMimeType: input.mediaMimeType ?? null,
      mediaFileName: input.mediaFileName ?? null,
    });

    // Only actually enqueue on a genuinely new row - createIdempotent()
    // returning a pre-existing row (the idempotency-key conflict path)
    // means a send for this exact request was already queued/dispatched.
    if (record.wasCreated) {
      await enqueueOutboundMessage({ outboundMessageId: record.id });
    }

    return record;
  }
}

export const whatsappOutboundMessageService = new WhatsAppOutboundMessageService();
