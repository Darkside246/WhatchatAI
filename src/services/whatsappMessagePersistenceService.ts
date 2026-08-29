import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppMediaRepository, type WhatsAppMediaRecord } from '../repositories/whatsappMediaRepository.js';
import { WhatsAppJidMappingRepository } from '../repositories/whatsappJidMappingRepository.js';
import { CustomerIdentityRepository } from '../repositories/customerIdentityRepository.js';
import { ConversationEventRepository } from '../repositories/conversationEventRepository.js';
import type { WhatsAppChatRecord } from '../repositories/whatsappChatRepository.js';
import type { MediaType, MessageType } from '../domain/whatsapp/types.js';
import { chatTypeFromJidKind } from '../domain/whatsapp/chatType.js';
import { classifyJid, derivePhoneNumber } from '../domain/whatsapp/jid.js';
import { enqueueMediaDownload } from '../queue/queues/realtimeEventsQueue.js';
import { enqueueWithTimeout } from '../queue/enqueueWithTimeout.js';
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
  media: WhatsAppMediaRecord | null;
}

export class WhatsAppMessagePersistenceService {
  private readonly conversationEventRepository = new ConversationEventRepository(pool);

  /**
   * The one authoritative write path for an inbound/outbound WhatsApp message:
   * upsert contact -> upsert chat -> insert message -> record chat's last
   * message -> (if media) insert media metadata, all in a single transaction.
   * A duplicate whatsapp_message_id is not an error - the unique index makes
   * the insert a no-op and this returns the existing row.
   *
   * The actual media download is never done here (or in the transaction) -
   * it's a real network call to WhatsApp's CDN that can fail or take time.
   * Once the transaction commits, a download job is enqueued so a worker
   * fetches, verifies, and stores the real bytes out-of-band.
   */
  async persist(input: PersistIngestedMessageInput): Promise<PersistIngestedMessageResult> {
    const result = await withTransaction((client) => this.persistWithClient(client, input));

    if (result.media && input.ingested.mediaDescriptor) {
      // The message/media rows are already durably committed above, so a
      // slow/unreachable Redis must never hang this caller indefinitely -
      // see enqueueWithTimeout. Reached from the incoming-messages worker
      // (never a synchronous HTTP request) but wrapped for the same
      // uniform guarantee as every other producer in this codebase.
      await enqueueWithTimeout(
        enqueueMediaDownload({
          businessId: input.businessId,
          whatsappAccountId: input.whatsappAccountId,
          mediaId: result.media.id,
          mediaDescriptor: input.ingested.mediaDescriptor,
        }),
        `media download ${result.media.id}`,
      );
    }

    // Additive observability, not a correctness-critical write: appended
    // after the transaction above has already durably committed, on its
    // own connection (ConversationEventRepository.append() opens its own
    // transaction for the advisory lock + sequence computation), and never
    // allowed to fail the real message write - a lost event is far less
    // costly than a customer's message failing to persist because of a
    // bug in this side channel. Awaited so callers/tests observe a
    // consistent end state rather than racing a fire-and-forget write.
    // Only a genuinely new, live, inbound message gets one, mirroring the
    // same wasInserted/fromMe/isLive conditions already used above for the
    // unread-counter increment.
    if (!result.deduplicated && !input.ingested.fromMe && input.ingested.isLive) {
      try {
        await this.conversationEventRepository.append({
          businessId: input.businessId,
          chatId: result.chat.id,
          eventType: 'message_received',
          payload: { messageId: result.message.id, contentType: input.ingested.contentType },
        });
      } catch (error) {
        console.error('[WhatsAppMessagePersistenceService] Failed to append message_received event:', error instanceof Error ? error.message : error);
      }
    }

    return result;
  }

  /**
   * Persists a real LID<->phone pairing the instant it's ever seen on a
   * message key - never called for a non-LID jid or when Baileys didn't
   * attach an alt jid, so this only ever writes mappings Baileys itself
   * supplied, matching the one existing writer of this table
   * (whatsappSyncService's own doc comment on the same guarantee).
   */
  private async captureJidMapping(
    jidMappingRepo: WhatsAppJidMappingRepository,
    businessId: string,
    whatsappAccountId: string,
    jid: string,
    jidKind: ReturnType<typeof classifyJid>,
    altJid: string | null,
  ): Promise<void> {
    if (jidKind !== 'lid' || !altJid) return;
    const phoneNumber = derivePhoneNumber(jid, jidKind, altJid);
    if (!phoneNumber) return;
    await jidMappingRepo.upsert(businessId, whatsappAccountId, jid, altJid, phoneNumber, 'baileys_alt_jid', 'high');
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
    const jidMappingRepo = new WhatsAppJidMappingRepository(client);
    const customerIdentityRepo = new CustomerIdentityRepository(client);

    // A real LID-to-phone pairing can arrive on ANY message, not just
    // during a contacts/history sync - Baileys attaches it directly to the
    // message key whenever it knows one. Captured here, on every message,
    // so a contact that never appears in a contacts.upsert payload (an
    // unsaved sender, a strict-privacy account) still gets a resolvable
    // mapping the moment it first messages this account.
    await this.captureJidMapping(jidMappingRepo, businessId, whatsappAccountId, ingested.remoteJid, ingested.jidKind, ingested.remoteJidAlt);
    if (ingested.participant) {
      await this.captureJidMapping(
        jidMappingRepo,
        businessId,
        whatsappAccountId,
        ingested.participant,
        classifyJid(ingested.participant),
        ingested.participantAlt,
      );
    }

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
      // Additive: gives this contact a channel-agnostic customer UUID
      // (Phase 1 of the identity roadmap) without changing anything about
      // the WhatsApp identity this function already resolves - contactId
      // above remains the one this function returns and every existing
      // caller keeps using.
      await customerIdentityRepo.getOrCreateForWhatsAppContact(businessId, contact.id, contact.displayName ?? contact.pushName ?? null);
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
    let media: WhatsAppMediaRecord | null = null;
    if (message.wasInserted) {
      // Only a genuinely new, live, inbound message counts as "unread" - our
      // own outbound sends and historical backfill are never unread.
      const incrementUnread = !ingested.fromMe && ingested.isLive;
      await chatRepo.recordLastMessage(chat.id, message.id, timestamp, incrementUnread);
      updatedChat = {
        ...chat,
        lastMessageId: message.id,
        lastMessageAt: timestamp,
        messageCount: chat.messageCount + 1,
        unreadCount: chat.unreadCount + (incrementUnread ? 1 : 0),
      };

      if (isMedia) {
        media = await mediaRepo.insert({
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

    return { message, chat: updatedChat, deduplicated: !message.wasInserted, media };
  }
}

export const whatsappMessagePersistenceService = new WhatsAppMessagePersistenceService();
