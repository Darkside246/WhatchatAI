import type { MediaType } from './types.js';
import { normalizeMimeType } from './mimeType.js';

/**
 * Driven entirely by real MIME types the connector/browser actually report -
 * never by guessing from a filename extension alone (the directive's own
 * "DOCUMENT MIME RULE"). Extension resolution falls back to the filename
 * only when no reliable MIME is available.
 */

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm']);
const AUDIO_MIME_TYPES = new Set(['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac']);
const STICKER_MIME_TYPES = new Set(['image/webp']);

// Browsers can natively play these without server-side transcoding.
const BROWSER_PLAYABLE_VIDEO = new Set(['video/mp4', 'video/webm']);
const BROWSER_PLAYABLE_AUDIO = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg']);

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
};

/**
 * MIME types that are safe for a browser to render inline in this app's own
 * origin. Anything outside this set is still stored and downloadable, but is
 * served as an attachment with a neutral content type - a WhatsApp sender
 * controls the MIME on media they send, so honouring an arbitrary one
 * inline (text/html, image/svg+xml) would let them run script against an
 * authenticated agent's session.
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/3gpp',
  'video/quicktime',
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/aac',
  'application/pdf',
]);

export function isInlineSafeMime(mimeType: string | null): boolean {
  return INLINE_SAFE_MIME_TYPES.has(normalizeMimeType(mimeType));
}

export function isSupportedMime(mimeType: string | null): boolean {
  // Every real MIME type WhatsApp/Baileys can hand us is at least
  // downloadable and storable - "supported" here means "not silently
  // discarded", not "the browser can render it inline". Only a genuinely
  // missing MIME type is unsupported.
  return Boolean(mimeType);
}

export function resolveMediaType(rawContentType: string): MediaType {
  switch (rawContentType) {
    case 'image':
    case 'video':
    case 'audio':
    case 'voice_note':
    case 'document':
    case 'sticker':
      return rawContentType;
    default:
      return 'document';
  }
}

/** Prefers the real filename extension; falls back to a MIME-derived one; never fabricates one from nothing. */
export function resolveExtension(mimeType: string | null, fileName: string | null): string | null {
  if (fileName) {
    const match = /\.([a-zA-Z0-9]+)$/.exec(fileName);
    if (match?.[1]) return match[1].toLowerCase();
  }
  const normalized = normalizeMimeType(mimeType);
  if (normalized && MIME_TO_EXTENSION[normalized]) return MIME_TO_EXTENSION[normalized];
  return null;
}

export function canPreview(mediaType: MediaType, mimeType: string | null): boolean {
  if (mediaType === 'image' || mediaType === 'sticker') return true;
  if (mediaType === 'video') return BROWSER_PLAYABLE_VIDEO.has(normalizeMimeType(mimeType));
  if (mediaType === 'audio' || mediaType === 'voice_note') return BROWSER_PLAYABLE_AUDIO.has(normalizeMimeType(mimeType));
  return false;
}

export function canStream(mediaType: MediaType): boolean {
  return mediaType === 'video' || mediaType === 'audio' || mediaType === 'voice_note';
}

export function canDownload(): boolean {
  // Any successfully stored file can always be downloaded, regardless of
  // whether the browser can preview it inline.
  return true;
}

export function requiresConversion(mediaType: MediaType, mimeType: string | null): boolean {
  if (mediaType === 'video') return !BROWSER_PLAYABLE_VIDEO.has(normalizeMimeType(mimeType));
  if (mediaType === 'audio' || mediaType === 'voice_note') return !BROWSER_PLAYABLE_AUDIO.has(normalizeMimeType(mimeType));
  return false;
}

export function requiresThumbnail(mediaType: MediaType): boolean {
  return mediaType === 'video' || mediaType === 'document';
}

/**
 * Transcoding (FFmpeg) is not wired in this pass - always false today, so
 * nothing downstream believes a conversion happened that didn't. See
 * requiresConversion() for what *would* need it once a transcoder exists.
 */
export function requiresTranscoding(): boolean {
  return false;
}

export function classifyMimeFamily(mimeType: string | null): 'image' | 'video' | 'audio' | 'sticker' | 'other' {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) return 'other';
  if (STICKER_MIME_TYPES.has(normalized)) return 'sticker';
  if (IMAGE_MIME_TYPES.has(normalized)) return 'image';
  if (VIDEO_MIME_TYPES.has(normalized)) return 'video';
  if (AUDIO_MIME_TYPES.has(normalized)) return 'audio';
  return 'other';
}
