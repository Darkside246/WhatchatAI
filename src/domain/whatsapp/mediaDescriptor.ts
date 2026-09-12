import type { proto } from '@whiskeysockets/baileys';

/**
 * The five message fields that can carry real, downloadable media bytes -
 * the same set the ingestion service classifies as downloadable.
 */
const MEDIA_CONTENT_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

export type MediaContentKey = (typeof MEDIA_CONTENT_KEYS)[number];

/** Whichever media field this message actually carries, or null when it carries none. */
export function findMediaContentKey(message: proto.IMessage | null | undefined): MediaContentKey | null {
  if (!message) return null;
  for (const key of MEDIA_CONTENT_KEYS) {
    const content = (message as Record<string, unknown>)[key];
    if (content && typeof content === 'object') return key;
  }
  return null;
}

export type NormaliseResult =
  | { ok: true; message: proto.IMessage }
  | { ok: false; reason: string };

/**
 * Repairs a media message that has been through the job queue, so Baileys'
 * own downloadMediaMessage still picks the FULL media rather than its
 * thumbnail.
 *
 * WHY THIS IS NEEDED AT ALL. Baileys decides between the two with a bare
 * property test:
 *
 *     if ('thumbnailDirectPath' in media && !('url' in media)) { ...download the thumbnail... }
 *
 * On a live, protobuf-decoded message that test is reliable: `in` walks the
 * prototype chain, and protobufjs puts a default `url` on the prototype of
 * every decoded message, so `'url' in media` is true whether or not the
 * sender actually set it.
 *
 * Our media-download worker does not hold the decoded message. The
 * descriptor is carried to it through BullMQ, which means JSON - and the
 * trip through JSON.stringify/parse (and through encodeBuffersForQueue,
 * which copies own enumerable properties only) throws the prototype away.
 * A field the sender left unset then has no key at all on the far side, so
 * `'url' in media` becomes FALSE for exactly the messages whose `url` was
 * never on the wire - the ones that carry only `directPath`.
 *
 * The consequence is silent and total: Baileys downloads the THUMBNAIL,
 * decrypts it with the thumbnail's own HKDF key, and hands back a few
 * kilobytes of preview image. Our checksum check then compares those bytes
 * against the full media's sender-declared fileSha256, they do not match,
 * and the download is retried and finally recorded as failed - forever,
 * because nothing about it is transient.
 *
 * So an explicit own `url` is put back. An empty string is deliberate and
 * correct rather than a placeholder: downloadContentFromMessage prefers
 * `directPath` whenever it has one and only reads `url` to recover the CDN
 * host, where an unparseable value already means "use the default host".
 */
export function normaliseMediaDescriptorForDownload(message: proto.IMessage): NormaliseResult {
  const key = findMediaContentKey(message);
  if (!key) return { ok: false, reason: 'Descriptor carries no image/video/audio/document/sticker content' };

  const content = { ...((message as Record<string, unknown>)[key] as Record<string, unknown>) };

  const directPath = typeof content.directPath === 'string' ? content.directPath : '';
  const url = typeof content.url === 'string' ? content.url : '';

  // Nothing to fetch from. Worth saying out loud rather than letting
  // Baileys raise its generic "no valid media URL or directPath present":
  // this is a message we should never have queued a download for, and a
  // retry cannot invent a location for it.
  if (!directPath && !url) {
    return { ok: false, reason: `${key} carries neither a url nor a directPath - there is nowhere to download it from` };
  }

  if (!('mediaKey' in content)) {
    return { ok: false, reason: `${key} carries no mediaKey - its bytes cannot be decrypted` };
  }

  content.url = url;

  return { ok: true, message: { ...message, [key]: content } as proto.IMessage };
}
