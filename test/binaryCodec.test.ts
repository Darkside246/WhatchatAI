import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encodeBuffersForQueue, decodeBuffersFromQueue } from '../src/domain/whatsapp/binaryCodec.js';

describe('binaryCodec (real Buffer <-> base64 round trip through actual JSON serialization)', () => {
  it('round-trips a raw Buffer through a real JSON.stringify/parse cycle, byte for byte', () => {
    const original = randomBytes(64);
    const encoded = encodeBuffersForQueue(original);

    // This is the exact operation BullMQ performs on job data - if the
    // codec doesn't survive this, it doesn't survive the real queue.
    const roundTripped = JSON.parse(JSON.stringify(encoded)) as unknown;
    const decoded = decodeBuffersFromQueue(roundTripped) as Buffer;

    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(decoded.equals(original)).toBe(true);
  });

  it('recursively encodes/decodes every Buffer field nested inside a real Baileys-shaped media descriptor', () => {
    const descriptor = {
      key: { remoteJid: '15551234567@s.whatsapp.net', id: 'MSG-1', fromMe: false },
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/example',
          mimetype: 'image/jpeg',
          mediaKey: randomBytes(32),
          fileEncSha256: randomBytes(32),
          fileSha256: randomBytes(32),
          jpegThumbnail: randomBytes(200),
        },
      },
    };

    const roundTripped = JSON.parse(JSON.stringify(encodeBuffersForQueue(descriptor))) as unknown;
    const decoded = decodeBuffersFromQueue(roundTripped) as typeof descriptor;

    expect(decoded.key.id).toBe('MSG-1');
    expect(decoded.message.imageMessage.mimetype).toBe('image/jpeg');
    expect(Buffer.isBuffer(decoded.message.imageMessage.mediaKey)).toBe(true);
    expect((decoded.message.imageMessage.mediaKey as Buffer).equals(descriptor.message.imageMessage.mediaKey)).toBe(true);
    expect((decoded.message.imageMessage.fileEncSha256 as Buffer).equals(descriptor.message.imageMessage.fileEncSha256)).toBe(true);
    expect((decoded.message.imageMessage.fileSha256 as Buffer).equals(descriptor.message.imageMessage.fileSha256)).toBe(true);
    expect((decoded.message.imageMessage.jpegThumbnail as Buffer).equals(descriptor.message.imageMessage.jpegThumbnail)).toBe(true);
  });

  it('round-trips Buffers inside arrays', () => {
    const buffers = [randomBytes(8), randomBytes(16), randomBytes(4)];
    const roundTripped = JSON.parse(JSON.stringify(encodeBuffersForQueue(buffers))) as unknown;
    const decoded = decodeBuffersFromQueue(roundTripped) as Buffer[];

    expect(decoded).toHaveLength(3);
    decoded.forEach((buffer, index) => {
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.equals(buffers[index]!)).toBe(true);
    });
  });

  it('leaves plain, non-binary values untouched', () => {
    const value = { text: 'hello', count: 3, nested: { flag: true, list: [1, 2, 3] }, empty: null };
    const roundTripped = JSON.parse(JSON.stringify(encodeBuffersForQueue(value))) as unknown;
    expect(decodeBuffersFromQueue(roundTripped)).toEqual(value);
  });
});
