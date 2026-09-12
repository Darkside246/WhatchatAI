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
  /** Structured detail for a location / shared contact / poll message - the real content WhatsApp does not put in the text body. Null for every other type. */
  structuredPayload: StructuredMessagePayload | null;
  /** WhatsApp's own contextInfo.isForwarded - true when the sender forwarded this from another chat rather than writing it here. Straight off the envelope, never inferred from the text. */
  isForwarded: boolean;
  /** WhatsApp's own contextInfo.forwardingScore - how many hops the message has travelled. The official client labels >= 5 "forwarded many times". Null when WhatsApp sent no score. */
  forwardingScore: number | null;
  /** WhatsApp's own contextInfo.stanzaId when this message is a reply/quote - resolved to our own row id at persist time (see whatsappMessagePersistenceService.ts). Null when this message isn't a reply. */
  quotedStanzaId: string | null;
  /**
   * What a protocolMessage envelope actually is - a deletion, an edit, a
   * disappearing-messages change, or WhatsApp's own plumbing. Null for
   * every ordinary message, which is almost all of them.
   */
  systemEvent: WhatsAppSystemEvent | null;
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
  /**
   * The structured detail of a non-media message type that carries real
   * content WhatsApp does not put in text: a location's coordinates, a
   * shared contact's card, a poll's question and options.
   *
   * Without this these messages were classified correctly and then rendered
   * as a bare type label - the operator could see that "a location" had
   * arrived but not where, or that "a poll" had arrived but not what it
   * asked. Only fields WhatsApp actually sent are included; nothing is
   * defaulted or invented.
   */
  structuredPayload: StructuredMessagePayload | null;
  /** What a protocolMessage envelope actually is. Null for every ordinary message - only a protocolMessage sets it. */
  systemEvent: WhatsAppSystemEvent | null;
}

/** Structured detail for the non-media message types that carry real content of their own. */
export type StructuredMessagePayload =
  | { kind: 'location'; latitude: number; longitude: number; name: string | null; address: string | null; isLive: boolean }
  | { kind: 'contacts'; contacts: Array<{ displayName: string | null; vcard: string | null }> }
  | { kind: 'poll'; question: string | null; options: string[]; selectableCount: number | null };

const MAX_BUFFER_SIZE = 500;
const TEXT_PREVIEW_MAX_LENGTH = 200;

/**
 * proto.Message.ProtocolMessage.Type, as real numbered enum members from
 * Baileys' own WAProto/index.d.ts. Raw numeric literals rather than an
 * import: this file takes `proto` as a type only, nothing else in this
 * codebase imports it as a value, and the numbers are wire format - they
 * cannot change without breaking every WhatsApp client at once.
 */
const PROTOCOL_MESSAGE_TYPE = {
  REVOKE: 0,
  EPHEMERAL_SETTING: 3,
  MESSAGE_EDIT: 14,
  GROUP_MEMBER_LABEL_CHANGE: 30,
} as const;

/**
 * What a protocolMessage envelope actually is.
 *
 * Every subtype used to collapse into one contentless 'system' row, and the
 * chat then rendered its generic fallback: the literal words "System
 * message", over and over, in the middle of a real conversation. Most of
 * those were never conversation at all - they are WhatsApp's own plumbing
 * (app-state key shares, history-sync notifications, peer-data operations,
 * LID migration) that the official client never shows anyone, and the rest
 * were real events whose meaning was thrown away.
 *
 * So each envelope is now identified. 'plumbing' is dropped before it can
 * reach the database; the others each say what happened.
 */
export type WhatsAppSystemEvent =
  /** The sender deleted a message for everyone. targetMessageId is WhatsApp's own id for the message being withdrawn. */
  | { kind: 'revoke'; targetMessageId: string | null }
  /** The sender edited an earlier message. newText is the replacement body. */
  | { kind: 'edit'; targetMessageId: string | null; newText: string | null }
  /** Disappearing messages were turned on, off, or changed. Zero seconds means off. */
  | { kind: 'ephemeral_setting'; expirationSeconds: number }
  /** A group member was given a short label/nickname by another member. */
  | { kind: 'member_label'; label: string }
  /** WhatsApp talking to itself. Never a conversation message, never persisted. */
  | { kind: 'plumbing'; typeCode: number };

/** Real, human wording for a system event - never the raw subtype name, and never the word "System message". */
function describeSystemEvent(event: WhatsAppSystemEvent): string | null {
  switch (event.kind) {
    case 'revoke':
      return 'This message was deleted';
    case 'ephemeral_setting':
      return event.expirationSeconds > 0
        ? `Disappearing messages turned on - ${formatDuration(event.expirationSeconds)}`
        : 'Disappearing messages turned off';
    case 'member_label':
      return `Member tag: ${event.label}`;
    // An edit is applied to the message it edits, so it has no line of its
    // own; plumbing never reaches a conversation at all.
    case 'edit':
    case 'plumbing':
      return null;
  }
}

/** WhatsApp offers 24 hours, 7 days and 90 days; anything else is still described honestly rather than rounded to one of them. */
function formatDuration(seconds: number): string {
  const days = Math.round(seconds / 86_400);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.round(seconds / 3_600);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function classifyProtocolMessage(protocol: proto.Message.IProtocolMessage): WhatsAppSystemEvent {
  const typeCode = typeof protocol.type === 'number' ? protocol.type : -1;

  if (typeCode === PROTOCOL_MESSAGE_TYPE.REVOKE) {
    return { kind: 'revoke', targetMessageId: protocol.key?.id ?? null };
  }
  if (typeCode === PROTOCOL_MESSAGE_TYPE.MESSAGE_EDIT) {
    const edited = protocol.editedMessage;
    const newText = edited?.conversation ?? edited?.extendedTextMessage?.text ?? null;
    return { kind: 'edit', targetMessageId: protocol.key?.id ?? null, newText };
  }
  if (typeCode === PROTOCOL_MESSAGE_TYPE.EPHEMERAL_SETTING) {
    return { kind: 'ephemeral_setting', expirationSeconds: Number(protocol.ephemeralExpiration ?? 0) };
  }
  if (typeCode === PROTOCOL_MESSAGE_TYPE.GROUP_MEMBER_LABEL_CHANGE && protocol.memberLabel?.label) {
    return { kind: 'member_label', label: protocol.memberLabel.label };
  }

  // Everything else: app-state key share/request, history sync
  // notification, msg-fanout backfill, initial security notification,
  // peer data operations, LID migration mapping, bot feedback, and the
  // rest. The official client shows none of them to anyone.
  return { kind: 'plumbing', typeCode };
}

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
    structuredPayload: null,
    systemEvent: null,
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
      structuredPayload: null,
      systemEvent: null,
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
    const location = message.locationMessage ?? message.liveLocationMessage;
    const latitude = location?.degreesLatitude;
    const longitude = location?.degreesLongitude;
    return {
      ...empty,
      contentType: 'location',
      // Coordinates only when WhatsApp really sent both - a half-known
      // position is not a position, and a defaulted 0/0 would put every
      // such message in the Gulf of Guinea.
      structuredPayload:
        typeof latitude === 'number' && typeof longitude === 'number'
          ? {
              kind: 'location',
              latitude,
              longitude,
              name: (location as { name?: string | null } | null)?.name ?? null,
              address: (location as { address?: string | null } | null)?.address ?? null,
              isLive: Boolean(message.liveLocationMessage),
            }
          : null,
    };
  }
  if (message.contactsArrayMessage) {
    const contacts = (message.contactsArrayMessage.contacts ?? []).map((contact) => ({
      displayName: contact.displayName ?? null,
      vcard: contact.vcard ?? null,
    }));
    return {
      ...empty,
      contentType: 'contacts',
      structuredPayload: contacts.length > 0 ? { kind: 'contacts', contacts } : null,
    };
  }
  if (message.contactMessage) {
    return {
      ...empty,
      contentType: 'contact',
      structuredPayload: {
        kind: 'contacts',
        contacts: [{ displayName: message.contactMessage.displayName ?? null, vcard: message.contactMessage.vcard ?? null }],
      },
    };
  }
  if (message.reactionMessage) {
    return { ...empty, contentType: 'reaction', textPreview: message.reactionMessage.text ?? null, fullText: message.reactionMessage.text ?? null };
  }
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
    const poll = message.pollCreationMessage ?? message.pollCreationMessageV2 ?? message.pollCreationMessageV3;
    const options = (poll?.options ?? [])
      .map((option) => option.optionName ?? '')
      .filter((name) => name.trim().length > 0);
    return {
      ...empty,
      contentType: 'poll',
      // The question doubles as the preview text, so a poll finally reads as
      // something in the chat list instead of the word "Poll".
      textPreview: poll?.name ? truncatePreview(poll.name) : null,
      fullText: poll?.name ?? null,
      structuredPayload: {
        kind: 'poll',
        question: poll?.name ?? null,
        options,
        selectableCount: typeof poll?.selectableOptionsCount === 'number' ? poll.selectableOptionsCount : null,
      },
    };
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
    // Identified rather than collapsed - see WhatsAppSystemEvent. The
    // description, where there is one, is put in textPreview/fullText so it
    // reaches the chat through the path that already prefers real text over
    // the generic type label, with no frontend change needed.
    const systemEvent = classifyProtocolMessage(message.protocolMessage);
    const description = describeSystemEvent(systemEvent);
    return {
      ...empty,
      contentType: 'system',
      textPreview: description ? truncatePreview(description) : null,
      fullText: description,
      systemEvent,
    };
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
function extractReplyContext(content: proto.IMessage | null | undefined): {
  mentionedJids: string[];
  quotedStanzaId: string | null;
  isForwarded: boolean;
  forwardingScore: number | null;
} {
  const { message } = unwrapContent(content);
  const contextInfo =
    message?.extendedTextMessage?.contextInfo ??
    message?.imageMessage?.contextInfo ??
    message?.videoMessage?.contextInfo ??
    message?.audioMessage?.contextInfo ??
    message?.documentMessage?.contextInfo ??
    message?.stickerMessage?.contextInfo ??
    null;

  // WhatsApp's own forwarding metadata, exactly as the official client reads
  // it. isForwarded is the flag WhatsApp sets when a message was forwarded
  // rather than written to this chat; forwardingScore counts how many hops
  // it has travelled (>= 5 is what the official client labels "forwarded
  // many times"). Both come straight off the envelope - never inferred from
  // the message text, which would be guessing.
  const forwardingScore = typeof contextInfo?.forwardingScore === 'number' ? contextInfo.forwardingScore : null;

  return {
    mentionedJids: (contextInfo?.mentionedJid ?? []).filter((jid): jid is string => Boolean(jid)),
    quotedStanzaId: contextInfo?.stanzaId ?? null,
    isForwarded: Boolean(contextInfo?.isForwarded) || (forwardingScore !== null && forwardingScore > 0),
    forwardingScore,
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

/**
 * Whether this envelope belongs in a conversation at all.
 *
 * WhatsApp's own plumbing - app-state key shares and requests, history-sync
 * notifications, msg-fanout backfill, the initial security-notification
 * sync, peer data operations, LID migration mapping, bot feedback - arrives
 * as ordinary-looking messages on ordinary chats. The official client shows
 * none of it to anyone. Persisting it produced a row with no content, which
 * the chat then rendered as the literal words "System message" in the
 * middle of a real conversation, and which the AI saw as a turn that had
 * happened.
 *
 * Called by both ingestion consumers (the live messages.upsert handler and
 * the history-sync path) rather than inside ingestUpsert itself, so the
 * in-memory buffer and the diagnostic counters still see everything that
 * really arrived.
 */
export function isConversationalMessage(message: IngestedWhatsAppMessage): boolean {
  return message.systemEvent?.kind !== 'plumbing';
}
