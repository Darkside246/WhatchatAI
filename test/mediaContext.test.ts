import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import { WhatsAppMediaRepository } from '../src/repositories/whatsappMediaRepository.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { storeMedia } from '../src/media/localEncryptedMediaStorage.js';
import { resolveInlineMediaPart, mediaFallbackText } from '../src/services/ai/mediaContext.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';

const MEDIA_STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR ?? './data/media-storage');

/**
 * Real Postgres + real encrypted-disk media rows throughout - this is the
 * exact same code path processMediaDownload uses once a real download
 * succeeds, so a passing test here means the AI reply path really can
 * decrypt and forward genuine image/audio bytes to Gemini, not a mock.
 */
describe('resolveInlineMediaPart (real Postgres media row, real encrypted-at-rest bytes)', () => {
  let businessId: string;
  let accountId: string;
  const accountJid = '15550009999@s.whatsapp.net';

  afterAll(async () => {
    if (businessId) await rm(path.join(MEDIA_STORAGE_DIR, businessId), { recursive: true, force: true });
  });

  async function insertMediaMessage(overrides: {
    mimetype: string | null;
    contentType: 'image' | 'audio' | 'voice_note' | 'document';
  }): Promise<string> {
    const messageId = `MEDIA-CTX-${Date.now()}-${Math.random()}`;
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: '15550008888@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550008888',
      participant: null,
      remoteJidAlt: null,
      participantAlt: null,
      fromMe: false,
      pushName: 'Media Context Test Contact',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: overrides.contentType,
      documentSubtype: null,
      mimetype: overrides.mimetype,
      fileName: null,
      textPreview: null,
      ingestedAt: new Date().toISOString(),
      // A real media descriptor isn't needed here - these tests drive
      // download completion directly via mediaRepository/storeMedia, the
      // same real calls processMediaDownload itself makes, without also
      // exercising the separate download-worker job.
      mediaDescriptor: null,
    };

    const result = await whatsappMessagePersistenceService.persist({ businessId, whatsappAccountId: accountId, accountJid, ingested });
    if (!result.media) throw new Error('expected a media row to be created for this content type');
    return result.media.id;
  }

  it('resolves real, decrypted, base64 bytes for an already-downloaded, checksum-verified, Gemini-supported image', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);

    const mediaId = await insertMediaMessage({ mimetype: 'image/jpeg', contentType: 'image' });
    const plaintext = randomBytes(4096);
    const sha256 = createHash('sha256').update(plaintext).digest('hex');
    const storageReference = await storeMedia(businessId, sha256, plaintext);

    const mediaRepository = new WhatsAppMediaRepository(pool);
    await mediaRepository.setDownloadResult(mediaId, 'downloaded', storageReference, sha256, plaintext.length);

    const part = await resolveInlineMediaPart(businessId, mediaId);
    expect(part).not.toBeNull();
    expect(part?.mimeType).toBe('image/jpeg');
    expect(Buffer.from(part!.data, 'base64').equals(plaintext)).toBe(true);
  });

  it('returns null when the media has not finished downloading yet - never fabricates bytes it does not have', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);

    const mediaId = await insertMediaMessage({ mimetype: 'image/jpeg', contentType: 'image' });
    // Left at the default 'pending' download_status - no setDownloadResult call.

    const part = await resolveInlineMediaPart(businessId, mediaId);
    expect(part).toBeNull();
  });

  it('returns null for a downloaded mimeType Gemini does not support inline (e.g. a .docx document) - degrades to text-only rather than erroring', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);

    const mediaId = await insertMediaMessage({
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentType: 'document',
    });
    const plaintext = randomBytes(1024);
    const sha256 = createHash('sha256').update(plaintext).digest('hex');
    const storageReference = await storeMedia(businessId, sha256, plaintext);

    const mediaRepository = new WhatsAppMediaRepository(pool);
    await mediaRepository.setDownloadResult(mediaId, 'downloaded', storageReference, sha256, plaintext.length);

    const part = await resolveInlineMediaPart(businessId, mediaId);
    expect(part).toBeNull();
  });

  it('returns null for a real voice note (audio/ogg; codecs=opus) that is too large for one inline request, rather than blowing up the Gemini call', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);

    const mediaId = await insertMediaMessage({ mimetype: 'audio/ogg; codecs=opus', contentType: 'voice_note' });
    const mediaRepository = new WhatsAppMediaRepository(pool);
    // A real 20MB voice note is implausible but not impossible - simulate
    // the size gate directly rather than actually allocating 20MB in a test.
    await mediaRepository.setDownloadResult(mediaId, 'downloaded', `${businessId}/${'a'.repeat(64)}`, 'a'.repeat(64), 20 * 1024 * 1024);

    const part = await resolveInlineMediaPart(businessId, mediaId);
    expect(part).toBeNull();
  });

  it('resolves real, decrypted, base64 bytes for a real WhatsApp voice note - the actual mimeType is "audio/ogg; codecs=opus", not the bare "audio/ogg", and must still be accepted', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);

    const mediaId = await insertMediaMessage({ mimetype: 'audio/ogg; codecs=opus', contentType: 'voice_note' });
    const plaintext = randomBytes(2048);
    const sha256 = createHash('sha256').update(plaintext).digest('hex');
    const storageReference = await storeMedia(businessId, sha256, plaintext);

    const mediaRepository = new WhatsAppMediaRepository(pool);
    await mediaRepository.setDownloadResult(mediaId, 'downloaded', storageReference, sha256, plaintext.length);

    const part = await resolveInlineMediaPart(businessId, mediaId);
    expect(part).not.toBeNull();
    // Sent to Gemini in its normalized (bare) form - Gemini's own
    // documented supported-type list is the bare form, and the codec
    // parameter is not part of it.
    expect(part?.mimeType).toBe('audio/ogg');
    expect(Buffer.from(part!.data, 'base64').equals(plaintext)).toBe(true);
  });

  it('returns null (not a thrown error) for a nonexistent mediaId - the caller degrades to text-only, never crashes the reply', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const part = await resolveInlineMediaPart(businessId, '00000000-0000-0000-0000-000000000000');
    expect(part).toBeNull();
  });
});

describe('mediaFallbackText (pure, honest placeholder text)', () => {
  it('describes a real media type factually when it is available to the model', () => {
    expect(mediaFallbackText('image', true)).toBe('[The customer sent a photo.]');
    expect(mediaFallbackText('voice_note', true)).toBe('[The customer sent a voice message.]');
  });

  it('never claims the model can see/hear media that could not actually be retrieved', () => {
    expect(mediaFallbackText('image', false)).toBe('[The customer sent a photo, but it could not be retrieved.]');
    expect(mediaFallbackText('audio', false)).toContain('could not be retrieved');
  });

  it('falls back to a generic, still-honest label for a media message type it has no specific label for', () => {
    expect(mediaFallbackText('text', true)).toBe('[The customer sent a file.]');
  });
});
