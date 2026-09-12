import { describe, expect, it } from 'vitest';
import { proto } from '@whiskeysockets/baileys';
import { encodeBuffersForQueue, decodeBuffersFromQueue } from '../src/domain/whatsapp/binaryCodec.js';
import { findMediaContentKey, normaliseMediaDescriptorForDownload } from '../src/domain/whatsapp/mediaDescriptor.js';

/**
 * A real protobuf round trip, not a hand-written object literal: the whole
 * bug being fixed here lives in the difference between a decoded protobuf
 * message and the plain object our job queue delivers, so a test that
 * started from a plain object would test nothing.
 */
function decodedImageMessage(fields: Record<string, unknown>): proto.IMessage {
  const encoded = proto.Message.encode(proto.Message.fromObject({ imageMessage: fields })).finish();
  return proto.Message.decode(encoded);
}

/** Exactly what BullMQ does to the descriptor between the two processes. */
function throughTheQueue(message: proto.IMessage): proto.IMessage {
  const encoded = JSON.parse(JSON.stringify(encodeBuffersForQueue({ key: { id: 'M1' }, message })));
  return (decodeBuffersFromQueue(encoded) as { message: proto.IMessage }).message;
}

const MEDIA_KEY = Buffer.alloc(32, 7);
const FILE_SHA = Buffer.alloc(32, 9);

describe('media descriptor normalisation', () => {
  /**
   * The channel case. WhatsApp does not always put `url` on the wire - a
   * message can carry only `directPath` - and protobuf then leaves the
   * field on the prototype rather than on the object.
   */
  it('the queue trip is what loses `url`, which is what this fixes', () => {
    const live = decodedImageMessage({ directPath: '/v/t62.7118-24/abc', mediaKey: MEDIA_KEY, fileSha256: FILE_SHA, thumbnailDirectPath: '/v/t62.36145/thumb' });

    // Alive and in-process, Baileys' own test passes: `in` finds the
    // protobuf default even though the sender never set the field.
    expect('url' in (live.imageMessage as object)).toBe(true);

    // After the queue it does not, which is the entire failure: Baileys
    // reads that as "no url, but there is a thumbnail" and downloads the
    // thumbnail instead of the photo.
    const delivered = throughTheQueue(live);
    expect('url' in (delivered.imageMessage as object)).toBe(false);

    const result = normaliseMediaDescriptorForDownload(delivered);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('url' in (result.message.imageMessage as object)).toBe(true);
    // The directPath is what actually gets fetched, so it must survive
    // untouched - the restored url is only there to keep Baileys on the
    // full-media branch.
    expect(result.message.imageMessage?.directPath).toBe('/v/t62.7118-24/abc');
  });

  it('leaves a message that does carry a url exactly as it is', () => {
    const delivered = throughTheQueue(
      decodedImageMessage({ url: 'https://mmg.whatsapp.net/v/t62.7118-24/abc', directPath: '/v/t62.7118-24/abc', mediaKey: MEDIA_KEY, fileSha256: FILE_SHA }),
    );
    const result = normaliseMediaDescriptorForDownload(delivered);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.imageMessage?.url).toBe('https://mmg.whatsapp.net/v/t62.7118-24/abc');
  });

  it('does not mutate the descriptor it was given', () => {
    const delivered = throughTheQueue(decodedImageMessage({ directPath: '/v/x', mediaKey: MEDIA_KEY }));
    normaliseMediaDescriptorForDownload(delivered);
    expect('url' in (delivered.imageMessage as object)).toBe(false);
  });

  describe('refuses, rather than retrying something that can never work', () => {
    it('media with nowhere to download from', () => {
      const result = normaliseMediaDescriptorForDownload(throughTheQueue(decodedImageMessage({ mediaKey: MEDIA_KEY })));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('nowhere to download it from');
    });

    it('media whose bytes could never be decrypted', () => {
      const result = normaliseMediaDescriptorForDownload(throughTheQueue(decodedImageMessage({ directPath: '/v/x' })));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('no mediaKey');
    });

    it('a descriptor carrying no media at all', () => {
      const result = normaliseMediaDescriptorForDownload({ conversation: 'hello' });
      expect(result.ok).toBe(false);
    });
  });

  it('finds whichever media field the message carries', () => {
    expect(findMediaContentKey({ videoMessage: { directPath: '/v/x' } })).toBe('videoMessage');
    expect(findMediaContentKey({ documentMessage: { directPath: '/v/x' } })).toBe('documentMessage');
    expect(findMediaContentKey({ conversation: 'hello' })).toBeNull();
    expect(findMediaContentKey(null)).toBeNull();
  });
});
