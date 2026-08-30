import { pool } from '../../db/pool.js';
import { WhatsAppMediaRepository } from '../../repositories/whatsappMediaRepository.js';
import { retrieveMedia } from '../../media/mediaStorage.js';
import { normalizeMimeType } from '../../domain/whatsapp/mimeType.js';
import type { MessageType } from '../../domain/whatsapp/types.js';

const mediaRepository = new WhatsAppMediaRepository(pool);

/**
 * Gemini's documented set of mimeTypes it can actually understand as inline
 * image/audio/video/document input - real WhatsApp media that falls outside
 * this list (e.g. a .docx document) is never force-fed to the model; it just
 * degrades to text-only (caption or fallback description), same as today.
 */
const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'audio/wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'video/mp4',
  'video/mpeg',
  'video/mov',
  'video/quicktime',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp',
  'application/pdf',
]);

// The real inline request-body budget, not Gemini's much larger Files API
// limit - this path always sends bytes inline in the same generateContent
// call, so it must stay comfortably under the provider's whole-request size
// ceiling once base64-inflated (~33% larger than the raw bytes).
const MAX_INLINE_MEDIA_BYTES = 15 * 1024 * 1024;

export interface InlineMediaPart {
  mimeType: string;
  data: string; // base64
}

/**
 * Resolves a real, already-downloaded, checksum-verified media row into the
 * exact {mimeType, data} shape Gemini's inlineData part expects - or null
 * when the media genuinely cannot be sent inline (not downloaded yet, an
 * unsupported mimeType, too large for one request, or the decrypt itself
 * fails). Never fabricates a part for media that was never actually
 * retrieved - callers must treat null as "reply text-only", not an error.
 */
export async function resolveInlineMediaPart(businessId: string, mediaId: string): Promise<InlineMediaPart | null> {
  const media = await mediaRepository.findByIdForBusiness(mediaId, businessId);
  if (!media || media.downloadStatus !== 'downloaded' || !media.storageReference) return null;

  // WhatsApp/Baileys report real mimeTypes with parameters attached (a
  // voice note is always `audio/ogg; codecs=opus`, never the bare
  // `audio/ogg`) - normalize before checking the allow-list, or every real
  // voice note fails this exact-match check and silently degrades to
  // text-only. Gemini's own supported-type list is the bare form, so the
  // normalized value is also what gets sent as inlineData.mimeType below,
  // never the raw, parameter-bearing one - only whatsapp_media's stored
  // value stays raw, since that is the real, complete media metadata.
  const normalizedMimeType = normalizeMimeType(media.mimeType);
  if (!normalizedMimeType || !SUPPORTED_MIME_TYPES.has(normalizedMimeType)) return null;
  if (media.fileSize !== null && media.fileSize > MAX_INLINE_MEDIA_BYTES) return null;

  const buffer = await retrieveMedia(businessId, media.storageReference).catch(() => null);
  if (!buffer) return null;

  return { mimeType: normalizedMimeType, data: buffer.toString('base64') };
}

const MEDIA_LABELS: Partial<Record<MessageType, string>> = {
  image: 'a photo',
  video: 'a video',
  audio: 'an audio message',
  voice_note: 'a voice message',
  document: 'a document',
  sticker: 'a sticker',
};

/**
 * Real, honest placeholder text for a media message with no caption - used
 * only for keyword routing and conversation-history reconstruction, never
 * shown to the customer. `available` distinguishes "the model can actually
 * see/hear this" (real bytes attached) from "we know it was sent but could
 * not retrieve it" (download failed/expired) - the model must never be left
 * assuming it saw something it did not.
 */
export function mediaFallbackText(messageType: MessageType, available: boolean): string {
  const label = MEDIA_LABELS[messageType] ?? 'a file';
  return available ? `[The customer sent ${label}.]` : `[The customer sent ${label}, but it could not be retrieved.]`;
}
