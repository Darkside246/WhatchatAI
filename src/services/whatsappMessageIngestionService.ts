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
  | 'call_event'
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
  /**
   * Which WhatsApp message type this was, when nothing here could classify
   * it. The protobuf field name only - structural, never content. Null for
   * every message that WAS classified, which is almost all of them.
   */
  unsupportedField: string | null;
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
  /**
   * The WhatsApp protobuf field this envelope carried, when nothing here
   * knew what to do with it.
   *
   * The chat renders an unclassified message as the bare word "Message",
   * and until now that was the end of the trail: nobody could tell which of
   * WhatsApp's ninety-odd message types it had been, so the only way to
   * find out was to guess and re-deploy. The field NAME is structural, not
   * content - it says "pollResultSnapshotMessage", never anything the
   * customer wrote - so it is safe to store and is exactly what turns "some
   * messages show as Message" into a one-query answer:
   *
   *   SELECT raw_metadata->>'unsupportedField' AS field, count(*)
   *     FROM whatsapp_messages WHERE message_type = 'unknown'
   *    GROUP BY 1 ORDER BY 2 DESC;
   */
  unsupportedField: string | null;
}

/** Structured detail for the non-media message types that carry real content of their own. */
export type StructuredMessagePayload =
  | { kind: 'location'; latitude: number; longitude: number; name: string | null; address: string | null; isLive: boolean }
  | { kind: 'contacts'; contacts: Array<{ displayName: string | null; vcard: string | null }> }
  | { kind: 'poll'; question: string | null; options: string[]; selectableCount: number | null }
  | {
      kind: 'call';
      outcome: WhatsAppCallOutcome;
      isVideo: boolean;
      /** Seconds the call actually lasted. Null whenever WhatsApp sent no duration - which is every call that never connected. */
      durationSecs: number | null;
      /** A group voice chat rather than a one-to-one call. */
      isVoiceChat: boolean;
      scheduled: boolean;
    };

/**
 * How a call ended, in our own words rather than WhatsApp's enum numbers.
 *
 * 'unknown' is a real member rather than an absent field: WhatsApp does send
 * call logs with no outcome, and a caller that has to distinguish "we were
 * not told" from "it connected" should not have to know that `undefined`
 * means the former.
 */
export type WhatsAppCallOutcome =
  | 'connected'
  | 'missed'
  | 'failed'
  | 'declined'
  | 'answered_elsewhere'
  | 'ongoing'
  | 'silenced_dnd'
  | 'silenced_unknown_caller'
  | 'unknown';

const MAX_BUFFER_SIZE = 500;
const TEXT_PREVIEW_MAX_LENGTH = 200;

/**
 * proto.Message.ProtocolMessage.Type, as real numbered enum members from
 * Baileys' own WAProto/index.d.ts. Raw numeric literals rather than an
 * import: this file takes `proto` as a type only, nothing else in this
 * codebase imports it as a value, and the numbers are wire format - they
 * cannot change without breaking every WhatsApp client at once.
 */
/** proto.Message.PinInChatMessage.Type, as raw numbers - wire format, taken as a type only. */
const PIN_IN_CHAT_TYPE = { PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 } as const;

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
  /**
   * Somebody pinned or unpinned a message in this conversation.
   *
   * Not a protocolMessage - WhatsApp sends it as its own top-level
   * pinInChatMessage, which is why it fell through the classifier entirely
   * and rendered as a bare bubble with no words in it.
   */
  | { kind: 'pin'; pinned: boolean; targetMessageId: string | null }
  /** A message was kept, or un-kept, so a disappearing-messages timer does not remove it. */
  | { kind: 'keep_in_chat'; kept: boolean; targetMessageId: string | null }
  /** Who may share what out of this chat was narrowed. */
  | { kind: 'limit_sharing' }
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
    case 'pin':
      // Deliberately not "X pinned a message": whoever did it is already
      // rendered as the sender of this event, and repeating a name we would
      // have to resolve separately is how a wrong name gets shown.
      return event.pinned ? 'Pinned a message' : 'Unpinned a message';
    case 'keep_in_chat':
      return event.kept ? 'Kept a message in this chat' : 'Stopped keeping a message';
    case 'limit_sharing':
      return 'Changed who can share from this chat';
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

/**
 * proto.Message.CallLogMessage.CallOutcome and .CallType, as raw numbers for
 * the same reason PROTOCOL_MESSAGE_TYPE above is: this file takes `proto` as
 * a type only, and these are wire format - they cannot change without
 * breaking every WhatsApp client at once.
 */
const CALL_OUTCOME = {
  CONNECTED: 0,
  MISSED: 1,
  FAILED: 2,
  REJECTED: 3,
  ACCEPTED_ELSEWHERE: 4,
  ONGOING: 5,
  SILENCED_BY_DND: 6,
  SILENCED_UNKNOWN_CALLER: 7,
} as const;

const CALL_TYPE = {
  REGULAR: 0,
  SCHEDULED_CALL: 1,
  VOICE_CHAT: 2,
} as const;

const CALL_OUTCOMES: Record<number, WhatsAppCallOutcome> = {
  [CALL_OUTCOME.CONNECTED]: 'connected',
  [CALL_OUTCOME.MISSED]: 'missed',
  [CALL_OUTCOME.FAILED]: 'failed',
  [CALL_OUTCOME.REJECTED]: 'declined',
  [CALL_OUTCOME.ACCEPTED_ELSEWHERE]: 'answered_elsewhere',
  [CALL_OUTCOME.ONGOING]: 'ongoing',
  [CALL_OUTCOME.SILENCED_BY_DND]: 'silenced_dnd',
  [CALL_OUTCOME.SILENCED_UNKNOWN_CALLER]: 'silenced_unknown_caller',
};

/**
 * A call that happened, read off the message WhatsApp puts in the chat for
 * it.
 *
 * This is a different thing from the live `call` socket event the connection
 * already handles (whatsappTenantConnection.ts -> whatsapp_calls, shown in
 * the Call History panel). That one is the ringing happening right now; this
 * one is the line WhatsApp writes into the conversation afterwards, which is
 * what the official client shows in the thread and what a history sync
 * brings back for calls that happened before we ever connected. Without it
 * the envelope matched nothing in classifyContent, fell through to
 * 'unsupported' -> 'unknown', and every missed call in a customer's thread
 * read as a bare "System message".
 *
 * Note the field name: `callLogMesssage`, with three s's. That is a real
 * typo in WhatsApp's own protobuf, not one here, and it cannot be corrected
 * without breaking the wire format.
 */
function classifyCallLog(log: proto.Message.ICallLogMessage): Extract<StructuredMessagePayload, { kind: 'call' }> {
  const outcomeCode = typeof log.callOutcome === 'number' ? log.callOutcome : -1;
  const typeCode = typeof log.callType === 'number' ? log.callType : CALL_TYPE.REGULAR;
  const duration = log.durationSecs == null ? null : Number(log.durationSecs);

  return {
    kind: 'call',
    outcome: CALL_OUTCOMES[outcomeCode] ?? 'unknown',
    isVideo: Boolean(log.isVideo),
    // Zero seconds is not a duration, it is the absence of one - every call
    // that never connected reports it, and "Voice call - 0s" would read as
    // though somebody hung up instantly.
    durationSecs: duration != null && duration > 0 ? duration : null,
    isVoiceChat: typeCode === CALL_TYPE.VOICE_CHAT,
    scheduled: typeCode === CALL_TYPE.SCHEDULED_CALL,
  };
}

/** "2m 14s". Minutes and seconds, because calls are minutes long and formatDuration above rounds to hours. */
function formatCallDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  return `${remainder}s`;
}

/**
 * Real wording for a call, from whichever side of it we are on.
 *
 * Direction matters to the words and to nothing else: the same envelope is
 * "Missed voice call" when a customer rang us and "No answer" when we rang
 * them, exactly as the official client shows it. Getting that backwards
 * would tell an owner they had missed a call they themselves placed.
 */
export function describeCall(
  call: Extract<StructuredMessagePayload, { kind: 'call' }>,
  fromMe: boolean,
): string {
  const base = call.isVoiceChat ? 'voice chat' : call.isVideo ? 'video call' : 'voice call';
  // "scheduled" belongs inside the noun, not in front of the sentence:
  // "Missed scheduled voice call" is English, "Scheduled Missed voice call"
  // is a string concatenation somebody read out loud.
  const noun = call.scheduled ? `scheduled ${base}` : base;
  const sentenceNoun = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;

  switch (call.outcome) {
    case 'missed':
      // Ours going unanswered is not us missing anything.
      return fromMe ? `${sentenceNoun} - no answer` : `Missed ${noun}`;
    case 'declined':
      return fromMe ? `${sentenceNoun} declined` : `${sentenceNoun} you declined`;
    case 'failed':
      return `${sentenceNoun} failed`;
    case 'ongoing':
      return `${sentenceNoun} in progress`;
    case 'silenced_dnd':
      return `${sentenceNoun} silenced - Do Not Disturb`;
    case 'silenced_unknown_caller':
      return `${sentenceNoun} silenced - unknown caller`;
    case 'answered_elsewhere':
      return `${sentenceNoun} answered on another device`;
    case 'connected':
    case 'unknown':
      // A duration is the one fact worth saying about a call that connected,
      // and the only honest thing to add when WhatsApp sent no outcome at all.
      return call.durationSecs != null
        ? `${sentenceNoun} - ${formatCallDuration(call.durationSecs)}`
        : `${sentenceNoun}`;
  }
}

function classifyProtocolMessage(protocol: proto.Message.IProtocolMessage): WhatsAppSystemEvent {
  const typeCode = typeof protocol.type === 'number' ? protocol.type : -1;

  if (typeCode === PROTOCOL_MESSAGE_TYPE.REVOKE) {
    return { kind: 'revoke', targetMessageId: protocol.key?.id ?? null };
  }
  if (typeCode === PROTOCOL_MESSAGE_TYPE.MESSAGE_EDIT) {
    /* An edit is not only ever an edit of plain text. WhatsApp lets
       somebody correct the CAPTION on a photo, a video or a document, and
       that arrives in exactly the same envelope with the new words on the
       media field instead. Reading only the two text shapes meant a caption
       correction was acknowledged and then silently not applied - the chat
       kept showing the words the customer had already replaced. */
    const edited = protocol.editedMessage;
    const newText =
      edited?.conversation ??
      edited?.extendedTextMessage?.text ??
      edited?.imageMessage?.caption ??
      edited?.videoMessage?.caption ??
      edited?.documentMessage?.caption ??
      null;
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

/**
 * `fromMe` is taken rather than inferred because one message type genuinely
 * reads differently from each side: a call log is "Missed voice call" when a
 * customer rang us and "No answer" when we rang them. Every other branch
 * ignores it.
 */
function classifyContent(content: proto.IMessage | null | undefined, fromMe: boolean): ClassifiedContent {
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
    unsupportedField: null,
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
      unsupportedField: null,
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
  if (
    message.pollCreationMessage ||
    message.pollCreationMessageV2 ||
    message.pollCreationMessageV3 ||
    // V4 and V5 are what a current phone actually sends. Without them a poll
    // from an up-to-date client classified as unsupported and rendered as a
    // bubble with nothing in it.
    message.pollCreationMessageV4 ||
    message.pollCreationMessageV5
  ) {
    const poll =
      message.pollCreationMessage ??
      message.pollCreationMessageV2 ??
      message.pollCreationMessageV3 ??
      /* V4 is wrapped in a future-proof envelope and V5 is not - checked
         against the protobuf rather than assumed, because guessing either
         way silently produces a poll with no question and no options. */
      message.pollCreationMessageV4?.message?.pollCreationMessage ??
      message.pollCreationMessageV5;
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
  if (message.callLogMesssage) {
    const call = classifyCallLog(message.callLogMesssage);
    const description = describeCall(call, fromMe);
    // The wording goes in textPreview/fullText as well as the payload, so a
    // call reads correctly in the chat list and in anything that only knows
    // how to show text - the same route the identified system events take.
    return {
      ...empty,
      contentType: 'call_event',
      textPreview: truncatePreview(description),
      fullText: description,
      structuredPayload: call,
    };
  }
  /**
   * Pinning, keeping and sharing limits.
   *
   * All three arrive as their own top-level message rather than inside a
   * protocolMessage, which is exactly why they fell past every branch above
   * and rendered as an empty bubble - reported as "he pinned a message and
   * our side showed a blank". They are conversation events with real
   * wording, so they classify as 'system' with a description like every
   * other event, never as unsupported.
   */
  if (message.pinInChatMessage) {
    const pinned = message.pinInChatMessage.type !== PIN_IN_CHAT_TYPE.UNPIN_FOR_ALL;
    const systemEvent: WhatsAppSystemEvent = {
      kind: 'pin',
      pinned,
      targetMessageId: message.pinInChatMessage.key?.id ?? null,
    };
    const description = describeSystemEvent(systemEvent);
    return { ...empty, contentType: 'system', textPreview: description, fullText: description, systemEvent };
  }

  if (message.keepInChatMessage) {
    /* KeepType 1 is "keep", anything else is undoing it. Read as a number
       for the same reason the other wire enums here are. */
    const kept = Number(message.keepInChatMessage.keepType ?? 0) === 1;
    const systemEvent: WhatsAppSystemEvent = {
      kind: 'keep_in_chat',
      kept,
      targetMessageId: message.keepInChatMessage.key?.id ?? null,
    };
    const description = describeSystemEvent(systemEvent);
    return { ...empty, contentType: 'system', textPreview: description, fullText: description, systemEvent };
  }

  if (message.limitSharingMessage) {
    const systemEvent: WhatsAppSystemEvent = { kind: 'limit_sharing' };
    const description = describeSystemEvent(systemEvent);
    return { ...empty, contentType: 'system', textPreview: description, fullText: description, systemEvent };
  }

  /**
   * A round video note. Real, ordinary media that simply had no branch, so
   * it arrived as an empty bubble with no way to play it.
   */
  if (message.ptvMessage) {
    return {
      ...empty,
      contentType: 'video',
      mimetype: message.ptvMessage.mimetype ?? null,
      rawMediaMessage: media(message),
    };
  }

  /** An animated sticker, which is still a sticker. */
  if (message.lottieStickerMessage) {
    return { ...empty, contentType: 'sticker', rawMediaMessage: media(message) };
  }

  /**
   * An event somebody created in the chat. The name is the whole point of
   * it, and without a branch here the operator saw that something had
   * arrived and not what.
   */
  if (message.eventMessage) {
    const event = message.eventMessage;
    const parts = [event.name?.trim(), event.description?.trim()].filter(Boolean);
    const text = event.isCanceled ? `Event cancelled: ${parts.join(' - ')}` : `Event: ${parts.join(' - ')}`;
    return { ...empty, contentType: 'interactive', textPreview: truncatePreview(text), fullText: text };
  }

  /**
   * Money and commerce.
   *
   * These matter more here than in a general chat client: this app is for
   * businesses taking payments, and a customer sending a payment request or
   * placing a catalogue order arriving as a blank bubble is the worst thing
   * on this whole list. Every one carries what it is worth or what it is
   * for, because "Payment" on its own tells an owner nothing.
   *
   * Nothing here is treated as a settled payment. WhatsApp's payment rails
   * are not available in most of the places this app runs, and these are
   * messages ABOUT money rather than proof of any - a request is a request,
   * and the kitchen gate is never opened by one.
   */
  if (message.requestPaymentMessage) {
    const request = message.requestPaymentMessage;
    // amount1000 is the amount in thousandths, which is WhatsApp's own unit
    // here - not cents, and not a mistake.
    const thousandths = Number(request.amount1000 ?? 0);
    const currency = request.currencyCodeIso4217 ?? '';
    const amount = thousandths > 0 ? `${currency} ${(thousandths / 1000).toFixed(2)}`.trim() : null;
    const note = request.noteMessage?.conversation ?? request.noteMessage?.extendedTextMessage?.text ?? null;
    const text = [`Payment requested${amount ? `: ${amount}` : ''}`, note].filter(Boolean).join(' - ');
    return { ...empty, contentType: 'interactive', textPreview: truncatePreview(text), fullText: text };
  }

  if (message.sendPaymentMessage) {
    const note =
      message.sendPaymentMessage.noteMessage?.conversation ??
      message.sendPaymentMessage.noteMessage?.extendedTextMessage?.text ??
      null;
    // Deliberately "sent a payment", never "paid": what reaches us is the
    // customer's claim, and this app must not turn a claim into a receipt.
    const text = note ? `Payment sent - ${note}` : 'Payment sent';
    return { ...empty, contentType: 'interactive', textPreview: truncatePreview(text), fullText: text };
  }

  if (message.cancelPaymentRequestMessage) {
    return { ...empty, contentType: 'interactive', textPreview: 'Payment request cancelled', fullText: 'Payment request cancelled' };
  }
  if (message.declinePaymentRequestMessage) {
    return { ...empty, contentType: 'interactive', textPreview: 'Payment request declined', fullText: 'Payment request declined' };
  }
  if (message.paymentInviteMessage) {
    const text = 'Invitation to set up payments';
    return { ...empty, contentType: 'interactive', textPreview: text, fullText: text };
  }

  if (message.orderMessage) {
    const order = message.orderMessage;
    const count = typeof order.itemCount === 'number' && order.itemCount > 0 ? `${order.itemCount} item${order.itemCount === 1 ? '' : 's'}` : null;
    const text = [`Order${order.orderTitle ? `: ${order.orderTitle}` : ''}`, count, order.message?.trim()]
      .filter(Boolean)
      .join(' - ');
    return { ...empty, contentType: 'interactive', textPreview: truncatePreview(text), fullText: text };
  }

  if (message.productMessage) {
    const title = message.productMessage.product?.title?.trim();
    const text = title ? `Product: ${title}` : 'A product from the catalogue';
    return { ...empty, contentType: 'interactive', textPreview: truncatePreview(text), fullText: text };
  }

  /**
   * A set of photos sent together. The pictures themselves arrive as their
   * own messages straight after; this is the header that says how many are
   * coming, which is why it has no media of its own to download.
   */
  if (message.albumMessage) {
    const images = Number(message.albumMessage.expectedImageCount ?? 0);
    const videos = Number(message.albumMessage.expectedVideoCount ?? 0);
    const parts = [images > 0 ? `${images} photo${images === 1 ? '' : 's'}` : null, videos > 0 ? `${videos} video${videos === 1 ? '' : 's'}` : null].filter(Boolean);
    const text = parts.length > 0 ? `Album - ${parts.join(', ')}` : 'Album';
    return { ...empty, contentType: 'interactive', textPreview: text, fullText: text };
  }

  /** The customer is being asked to share their number - worth seeing, since somebody is about to. */
  if (message.requestPhoneNumberMessage) {
    const text = 'Asked to share a phone number';
    return { ...empty, contentType: 'interactive', textPreview: text, fullText: text };
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

  /**
   * Nothing here knew what this was.
   *
   * Two different things end up here and they deserve different fates.
   *
   * WhatsApp's own transport metadata - the device-list blob it attaches to
   * ordinary sends, and the group key it distributes - can arrive as the
   * ONLY thing in an envelope. The official client shows neither to anyone,
   * so an envelope carrying nothing else is plumbing and is dropped before
   * it can become a bubble. It is checked as "the only field" rather than
   * "a field that is present", because both routinely ride ALONGSIDE real
   * content, and dropping those would delete real messages.
   *
   * Everything else is a genuine WhatsApp message type this app has not
   * taught itself yet. It still renders as the fallback, but it now records
   * WHICH type it was, so the next one is a query rather than a guess.
   */
  const carried = Object.keys(message).filter(
    (key) => (message as Record<string, unknown>)[key] !== null && (message as Record<string, unknown>)[key] !== undefined,
  );
  const PURE_TRANSPORT = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);
  if (carried.length > 0 && carried.every((key) => PURE_TRANSPORT.has(key))) {
    return { ...empty, contentType: 'system', systemEvent: { kind: 'plumbing', typeCode: -1 } };
  }

  return { ...empty, unsupportedField: carried.find((key) => !PURE_TRANSPORT.has(key)) ?? null };
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
  'call_event',
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
    const { rawMediaMessage, ...classified } = classifyContent(message.message, Boolean(key.fromMe));
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
