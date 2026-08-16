const BUFFER_MARKER = '__buffer_b64__';

interface EncodedBuffer {
  [BUFFER_MARKER]: string;
}

function isEncodedBuffer(value: unknown): value is EncodedBuffer {
  return typeof value === 'object' && value !== null && BUFFER_MARKER in value;
}

/**
 * Real Baileys media messages (imageMessage, videoMessage, ...) carry
 * binary fields (mediaKey, fileEncSha256, fileSha256, thumbnails, ...) as
 * Buffer/Uint8Array. BullMQ round-trips job data through JSON.stringify, and
 * plain JSON has no binary type - without this, those fields would arrive
 * in the worker as empty objects, and downloadMediaMessage() would silently
 * fail to decrypt real media. This walks the object tree and converts
 * Buffer/Uint8Array <-> base64 in both directions so the real bytes survive.
 */
export function encodeBuffersForQueue(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { [BUFFER_MARKER]: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map(encodeBuffersForQueue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = encodeBuffersForQueue(inner);
    }
    return out;
  }
  return value;
}

export function decodeBuffersFromQueue(value: unknown): unknown {
  if (isEncodedBuffer(value)) {
    return Buffer.from(value[BUFFER_MARKER], 'base64');
  }
  if (Array.isArray(value)) {
    return value.map(decodeBuffersFromQueue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = decodeBuffersFromQueue(inner);
    }
    return out;
  }
  return value;
}
