import type { MessageUpsertType, WAMessage, WAMessageKey, proto } from '@whiskeysockets/baileys';
import type Long from 'long';
import { classifyJid, derivePhoneNumber, type WhatsAppJidKind } from '../domain/whatsapp/jid.js';
import { encodeBuffersForQueue } from '../domain/whatsapp/binaryCodec.js';

const DOWNLOADABLE_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice_note', 'document', 'sticker']);

export type { WhatsAppJidKind };

export type WhatsAppMessageContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'voice_note'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'contacts'
  | 'reaction'
  | 'poll'
  | 'poll_response'
  | 'button'
  | 'interactive'
  | 'system'
  | 'unsupported';

export type WhatsAppDocumentSubtype = 'pdf' | 'spreadsheet' | 'other';

export interface IngestedWhatsAppMessage {
  messageId: string;
  remoteJid: string;
  jidKind: WhatsAppJidKind;
  phoneNumber: string | null;
  participant: string | null;
  /**
   * The real @s.whatsapp.net counterpart Baileys itself attached to this
   * message's key when remoteJid/participant is a @lid - the only
   * authoritative source for a LID-to-phone mapping outside of a full
   * contacts/history sync. Null whenever Baileys didn't supply one, never
   * a guess.
   */
  remoteJidAlt: string | null;
  participantAlt: string | null;
  fromMe: boolean;
  pushName: string | null;
  isLive: boolean;
  upsertType: MessageUpsertType;
  messageTimestamp: string | null;
  contentType: WhatsAppMessageContentType;
  documentSubtype: WhatsAppDocumentSubtype | null;
  mimetype: string | null;
  fileName: string | null;
  textPreview: string | null;
  /**
   * The real, untruncated text/caption - what actually gets persisted as a
   * message/status's permanent textContent (see whatsappMessagePersistenceService.ts,
   * whatsappStatusPersistenceService.ts) and what the Sentinel screens (see
   * incomingMessagesWorker.ts). textPreview is a separate, deliberately
   * truncated field for lightweight UI/diagnostic previews only (the
   * in-memory ingestion buffer, /api/whatsapp/messages/recent) - using it
   * for persistence would silently and permanently discard everything past
   * TEXT_PREVIEW_MAX_LENGTH, and using it for Sentinel screening would let
   * an attacker evade the check entirely by padding the first 200
   * characters with benign text.
   */
  fullText: string | null;
  ingestedAt: string;
  /**
   * Opaque, base64-encoded raw Baileys {key, message} for a downloadable
   * media message - only present for real media types, and never for
   * view-once media (WhatsApp's privacy model means view-once content is
   * intentionally not persisted). Decoded back into a WAMessage-shaped
   * object by the media-download worker via decodeBuffersFromQueue().
   */
  mediaDescriptor: Record<string, unknown> | null;
  /**
   * Real @mentions (WhatsApp's own contextInfo.mentionedJid), used by the
   * group-participation gate (groupParticipationGate.ts) to detect explicit
   * address in a group. Empty for a message that mentions no one, which is
   * the common case - not omitted, so every caller can rely on the field
   * always being an array.
   */
  mentionedJids: string[];
  /** WhatsApp's own contextInfo.stanzaId when this message is a reply/quote - resolved to our own row id at persist time (see whatsappMessagePersistenceService.ts). Null when this message isn't a reply. */
  quotedStanzaId: string | null;
}

interface ClassifiedContent {
  contentType: WhatsAppMessageContentType;
  documentSubtype: WhatsAppDocumentSubtype | null;
  mimetype: string | null;
  fileName: string | null;
  textPreview: string | null;
  fullText: string | null;
  /** The fully-unwrapped message content, only set for real downloadable media types. */
  rawMediaMessage: proto.IMessage | null;
}

const MAX_BUFFER_SIZE = 500;
const TEXT_PREVIEW_MAX_LENGTH = 200;

/**
 * proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE - a real,
 * numbered enum member confirmed in Baileys' own WAProto/index.d.ts. Used
 * as a raw numeric literal rather than importing the `proto` namespace as
 * a runtime value: this file already imports `proto` as a type only, and
 * nothing else in this codebase imports it as a value, so a literal here
 * is the more surgical change.
 */
const PROTOCOL_MESSAGE_TYPE_GROUP_MEMBER_LABEL_CHANGE = 30;

function classifyDocument(
  mimetype: string | null | undefined,
  fileName: string | null | undefined,
): WhatsAppDocumentSubtype {
  const mime = (mimetype ?? '').toLowerCase();
  const name = (fileName ?? '').toLowerCase();

  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (
    mime.includes('spreadsheet') ||
    mime === 'application/vnd.ms-excel' ||
    name.endsWith('.xls') ||
    name.endsWith('.xlsx')
  ) {
    return 'spreadsheet';
  }
  return 'other';
}

function truncatePreview(text: string): string {
  return text.length > TEXT_PREVIEW_MAX_LENGTH ? `${text.slice(0, TEXT_PREVIEW_MAX_LENGTH)}…` : text;
}

/**
 * Unwraps ephemeral / caption / edit message envelopes to reach the real
 * content. View-once is unwrapped for classification/preview purposes too,
 * but flagged separately - see isViewOnce - so callers can still show a
 * caption/preview without ever downloading the underlying media.
 */
function unwrapContent(
  message: proto.IMessage | null | undefined,
  isViewOnce = false,
): { message: proto.IMessage | null | undefined; isViewOnce: boolean } {
  if (!message) return { message, isViewOnce };

  const viewOnceWrapped =
    message.viewOnceMessage?.message ?? message.viewOnceMessageV2?.message ?? message.viewOnceMessageV2Extension?.message;
  if (viewOnceWrapped) return unwrapContent(viewOnceWrapped, true);

  const wrapped = message.ephemeralMessage?.message ?? message.documentWithCaptionMessage?.message ?? message.editedMessage?.message;
  if (wrapped) return unwrapContent(wrapped, isViewOnce);

  return { message, isViewOnce };
}

function classifyContent(content: proto.IMessage | null | undefined): ClassifiedContent {
  const empty: ClassifiedContent = {
    contentType: 'unsupported',
    documentSubtype: null,
    mimetype: null,
    fileName: null,
    textPreview: null,
    fullText: null,
    rawMediaMessage: null,
  };

  const { message, isViewOnce } = unwrapContent(content);
  if (!message) return empty;
  // View-once media is never downloaded/persisted (WhatsApp's own privacy
  // model), so rawMediaMessage is deliberately omitted for it below even
  // though classification/caption preview still works normally.
  const media = (raw: proto.IMessage): proto.IMessage | null => (isViewOnce ? null : raw);

  if (message.conversation) {
    return { ...empty, contentType: 'text', textPreview: truncatePreview(message.conversation), fullText: message.conversation };
  }
  if (message.extendedTextMessage?.text) {
    return {
      ...empty,
      contentType: 'text',
      textPreview: truncatePreview(message.extendedTextMessage.text),
      fullText: message.extendedTextMessage.text,
    };
  }
  if (message.imageMessage) {
    return {
      ...empty,
      contentType: 'image',
      mimetype: message.imageMessage.mimetype ?? null,
      textPreview: message.imageMessage.caption ? truncatePreview(message.imageMessage.caption) : null,
      fullText: message.imageMessage.caption ?? null,
      rawMediaMessage: media(message),
    };
  }
  if (message.videoMessage) {
    return {
      ...empty,
      contentType: 'video',
      mimetype: message.videoMessage.mimetype ?? null,
      textPreview: message.videoMessage.caption ? truncatePreview(message.videoMessage.caption) : null,
      fullText: message.videoMessage.caption ?? null,
      rawMediaMessage: media(message),
    };
  }
  if (message.audioMessage) {
    return {
      ...empty,
      contentType: message.audioMessage.ptt ? 'voice_note' : 'audio',
      mimetype: message.audioMessage.mimetype ?? null,
      rawMediaMessage: media(message),
    };
  }
  if (message.documentMessage) {
    const mimetype = message.documentMessage.mimetype ?? null;
    const fileName = message.documentMessage.fileName ?? null;
    return {
      contentType: 'document',
      documentSubtype: classifyDocument(mimetype, fileName),
      mimetype,
      fileName,
      textPreview: message.documentMessage.caption ? truncatePreview(message.documentMessage.caption) : null,
      fullText: message.documentMessage.caption ?? null,
      rawMediaMessage: media(message),
    };
  }
  if (message.stickerMessage) {
    return {
      ...empty,
      contentType: 'sticker',
      mimetype: message.stickerMessage.mimetype ?? null,
      rawMediaMessage: media(message),
    };
  }
  if (message.locationMessage || message.liveLocationMessage) {
    return { ...empty, contentType: 'location' };
  }
  if (message.contactsArrayMessage) {
    return { ...empty, contentType: 'contacts' };
  }
  if (message.contactMessage) {
    return { ...empty, contentType: 'contact' };
  }
  if (message.reactionMessage) {
    return { ...empty, contentType: 'reaction', textPreview: message.reactionMessage.text ?? null, fullText: message.reactionMessage.text ?? null };
  }
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
    return { ...empty, contentType: 'poll' };
  }
  if (message.pollUpdateMessage) {
    return { ...empty, contentType: 'poll_response' };
  }
  if (message.buttonsMessage || message.buttonsResponseMessage || message.templateButtonReplyMessage) {
    const buttonText =
      message.buttonsResponseMessage?.selectedDisplayText ?? message.templateButtonReplyMessage?.selectedDisplayText ?? null;
    return { ...empty, contentType: 'button', textPreview: buttonText ? truncatePreview(buttonText) : null, fullText: buttonText };
  }
  if (
    message.templateMessage ||
    message.listMessage ||
    message.listResponseMessage ||
    message.interactiveMessage ||
    message.interactiveResponseMessage ||
    message.groupInviteMessage
  ) {
    const interactiveText =
      message.listResponseMessage?.title ?? message.groupInviteMessage?.groupName ?? null;
    return { ...empty, contentType: 'interactive', textPreview: interactiveText ? truncatePreview(interactiveText) : null, fullText: interactiveText };
  }
  if (message.protocolMessage) {
    // WhatsApp's real "member tag" feature - a group member assigns
    // another member a short label/nickname. Was previously
    // indistinguishable from every other protocolMessage subtype (message
    // edits, ephemeral-setting changes, history-sync notifications, etc.),
    // all silently collapsed into a contentless 'system' bucket - the
    // chat UI's own generic "System message" fallback (messageBody() in
    // ChatThread.tsx) was the only thing a user ever saw, with the real
    // label text discarded. Populating textPreview/fullText here surfaces
    // it through that exact same fallback path with no frontend change
    // needed - messageBody() already prefers real text content over the
    // generic label whenever it's present.
    if (message.protocolMessage.type === PROTOCOL_MESSAGE_TYPE_GROUP_MEMBER_LABEL_CHANGE && message.protocolMessage.memberLabel?.label) {
      const label = message.protocolMessage.memberLabel.label;
      return { ...empty, contentType: 'system', textPreview: truncatePreview(`Member tag: ${label}`), fullText: `Member tag: ${label}` };
    }
    return { ...empty, contentType: 'system' };
  }

  return empty;
}

/**
 * Real @mention and reply/quote data - WhatsApp puts both in contextInfo,
 * a sibling field of whichever content type actually carries the message
 * (extendedTextMessage for a plain text reply, but any media type can
 * also carry a caption + reply). Deliberately NOT folded into
 * classifyContent above: that function's job is "what kind of content is
 * this," this one's job is "who was this addressed to/in response of" -
 * two independent questions about the same envelope, only one of which
 * (contentType) determines the DOWNLOADABLE_MEDIA_TYPES branch above.
 */
function extractReplyContext(content: proto.IMessage | null | undefined): { mentionedJids: string[]; quotedStanzaId: string | null } {
  const { message } = unwrapContent(content);
  const contextInfo =
    message?.extendedTextMessage?.contextInfo ??
    message?.imageMessage?.contextInfo ??
    message?.videoMessage?.contextInfo ??
    message?.audioMessage?.contextInfo ??
    message?.documentMessage?.contextInfo ??
    message?.stickerMessage?.contextInfo ??
    null;
  return {
    mentionedJids: (contextInfo?.mentionedJid ?? []).filter((jid): jid is string => Boolean(jid)),
    quotedStanzaId: contextInfo?.stanzaId ?? null,
  };
}

function toIsoTimestamp(value: number | Long | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const seconds = typeof value === 'number' ? value : value.toNumber();
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

export interface WhatsAppIngestionStats {
  bufferedCount: number;
  liveCount: number;
  historicalCount: number;
  byContentType: Record<WhatsAppMessageContentType, number>;
}

const CONTENT_TYPES: WhatsAppMessageContentType[] = [
  'text',
  'image',
  'video',
  'voice_note',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
  'contacts',
  'reaction',
  'poll',
  'poll_response',
  'button',
  'interactive',
  'system',
  'unsupported',
];

export class WhatsAppMessageIngestionService {
  private buffer: IngestedWhatsAppMessage[] = [];
  private liveCount = 0;
  private historicalCount = 0;
  private readonly countsByContentType = Object.fromEntries(
    CONTENT_TYPES.map((type) => [type, 0]),
  ) as Record<WhatsAppMessageContentType, number>;

  ingestUpsert(payload: { messages: WAMessage[]; type: MessageUpsertType }): IngestedWhatsAppMessage[] {
    const ingested = payload.messages
      .filter((message) => Boolean(message.key?.id && message.key?.remoteJid))
      .map((message) => this.toIngestedMessage(message, payload.type));

    for (const message of ingested) {
      this.buffer.push(message);
      if (this.buffer.length > MAX_BUFFER_SIZE) this.buffer.shift();
      this.countsByContentType[message.contentType] += 1;
      if (message.isLive) {
        this.liveCount += 1;
      } else {
        this.historicalCount += 1;
      }
    }

    return ingested;
  }

  getRecent(limit = 50): IngestedWhatsAppMessage[] {
    const bounded = Math.max(1, Math.min(limit, MAX_BUFFER_SIZE));
    return this.buffer.slice(-bounded).reverse();
  }

  getStats(): WhatsAppIngestionStats {
    return {
      bufferedCount: this.buffer.length,
      liveCount: this.liveCount,
      historicalCount: this.historicalCount,
      byContentType: { ...this.countsByContentType },
    };
  }

  private toIngestedMessage(message: WAMessage, upsertType: MessageUpsertType): IngestedWhatsAppMessage {
    const key = message.key as WAMessageKey;
    const remoteJid = key.remoteJid ?? '';
    const jidKind = classifyJid(remoteJid);
    const { rawMediaMessage, ...classified } = classifyContent(message.message);
    const replyContext = extractReplyContext(message.message);

    const mediaDescriptor =
      rawMediaMessage && DOWNLOADABLE_MEDIA_TYPES.has(classified.contentType)
        ? (encodeBuffersForQueue({ key, message: rawMediaMessage }) as Record<string, unknown>)
        : null;

    return {
      messageId: key.id ?? '',
      remoteJid,
      jidKind,
      phoneNumber: derivePhoneNumber(remoteJid, jidKind, key.remoteJidAlt ?? null),
      participant: key.participant ?? null,
      remoteJidAlt: key.remoteJidAlt ?? null,
      participantAlt: key.participantAlt ?? null,
      fromMe: Boolean(key.fromMe),
      pushName: message.pushName ?? null,
      isLive: upsertType === 'notify',
      upsertType,
      messageTimestamp: toIsoTimestamp(message.messageTimestamp ?? null),
      ingestedAt: new Date().toISOString(),
      ...classified,
      mediaDescriptor,
      ...replyContext,
    };
  }
}

export const whatsappMessageIngestionService = new WhatsAppMessageIngestionService();
