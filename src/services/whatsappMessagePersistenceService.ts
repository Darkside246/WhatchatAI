import type { PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppMediaRepository } from '../repositories/whatsappMediaRepository.js';
import type { WhatsAppChatRecord } from '../repositories/whatsappChatRepository.js';
import type { MediaType, MessageType } from '../domain/whatsapp/types.js';
import { chatTypeFromJidKind } from '../domain/whatsapp/chatType.js';
import type {
  IngestedWhatsAppMessage,
  WhatsAppDocumentSubtype,
  WhatsAppMessageContentType,
} from './whatsappMessageIngestionService.js';

const MEDIA_CONTENT_TYPES = new Set<WhatsAppMessageContentType>([
  'image',
  'video',
  'audio',
  'voice_note',
  'document',
  'sticker',
]);

function mapContentTypeToMessageType(
  contentType: WhatsAppMessageContentType,
  documentSubtype: WhatsAppDocumentSubtype | null,
): MessageType {
  if (contentType === 'document' && documentSubtype === 'spreadsheet') return 'spreadsheet';
  if (contentType === 'unsupported') return 'unknown';
  return contentType;
}

function mapContentTypeToMediaType(contentType: WhatsAppMessageContentType): MediaType {
  if (contentType === 'audio' || contentType === 'voice_note') return contentType;
  if (contentType === 'image' || contentType === 'video' || contentType === 'document' || contentType === 'sticker') {
    return contentType;
  }
  throw new Error(`${contentType} is not a media content type`);
}

export interface PersistIngestedMessageInput {
  businessId: string;
  whatsappAccountId: string;
  accountJid: string;
  ingested: IngestedWhatsAppMessage;
}

export interface PersistIngestedMessageResult {
  message: WhatsAppMessageRecord;
  chat: WhatsAppChatRecord;
  deduplicated: boolean;
}

export class WhatsAppMessagePersistenceService {
  /**
   * The one authoritative write path for an inbound/outbound WhatsApp message:
   * upsert contact -> upsert chat -> insert message -> record chat's last
   * message -> (if media) insert media metadata, all in a single transaction.
   * A duplicate whatsapp_message_id is not an error - the unique index makes
   * the insert a no-op and this returns the existing row.
   */
  async persist(input: PersistIngestedMessageInput): Promise<PersistIngestedMessageResult> {
    return withTransaction((client) => this.persistWithClient(client, input));
  }

  private async persistWithClient(
    client: PoolClient,
    input: PersistIngestedMessageInput,
  ): Promise<PersistIngestedMessageResult> {
    const { businessId, whatsappAccountId, accountJid, ingested } = input;
    const contactRepo = new WhatsAppContactRepository(client);
    const chatRepo = new WhatsAppChatRepository(client);
    const messageRepo = new WhatsAppMessageRepository(client);
    const mediaRepo = new WhatsAppMediaRepository(client);

    const chatType = chatTypeFromJidKind(ingested.jidKind);
    let contactId: string | null = null;

    if (chatType === 'individual') {
      const contact = await contactRepo.upsertFromWhatsApp({
        businessId,
        whatsappAccountId,
        whatsappJid: ingested.remoteJid,
        jidKind: ingested.jidKind,
        phoneNumber: ingested.phoneNumber,
        pushName: ingested.pushName,
      });
      contactId = contact.id;
    }

    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId,
      chatJid: ingested.remoteJid,
      jidKind: ingested.jidKind,
      chatType,
      contactId,
      phoneNumber: ingested.phoneNumber,
    });

    const senderJid = ingested.fromMe ? accountJid : (ingested.participant ?? ingested.remoteJid);
    const recipientJid = ingested.fromMe ? ingested.remoteJid : accountJid;
    const timestamp = ingested.messageTimestamp ?? ingested.ingestedAt;
    const isMedia = MEDIA_CONTENT_TYPES.has(ingested.contentType);

    const message = await messageRepo.insert({
      businessId,
      whatsappAccountId,
      chatId: chat.id,
      whatsappMessageId: ingested.messageId,
      remoteJid: ingested.remoteJid,
      senderJid,
      recipientJid,
      senderContactId: !ingested.fromMe ? contactId : null,
      direction: ingested.fromMe ? 'outbound' : 'inbound',
      messageType: mapContentTypeToMessageType(ingested.contentType, ingested.documentSubtype),
      textContent: ingested.textPreview,
      timestamp,
      fromMe: ingested.fromMe,
      isHistorical: !ingested.isLive,
      hasMedia: isMedia,
      rawMetadata: { upsertType: ingested.upsertType, jidKind: ingested.jidKind },
    });

    let updatedChat = chat;
    if (message.wasInserted) {
      await chatRepo.recordLastMessage(chat.id, message.id, timestamp);
      updatedChat = {
        ...chat,
        lastMessageId: message.id,
        lastMessageAt: timestamp,
        messageCount: chat.messageCount + 1,
      };

      if (isMedia) {
        const media = await mediaRepo.insert({
          businessId,
          whatsappAccountId,
          messageId: message.id,
          mediaType: mapContentTypeToMediaType(ingested.contentType),
          mimeType: ingested.mimetype,
          fileName: ingested.fileName,
        });
        await messageRepo.attachMedia(message.id, media.id);
      }
    }

    return { message, chat: updatedChat, deduplicated: !message.wasInserted };
  }
}

export const whatsappMessagePersistenceService = new WhatsAppMessagePersistenceService();
