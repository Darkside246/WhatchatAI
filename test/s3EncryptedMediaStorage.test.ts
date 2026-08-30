import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'node:stream';

const s3Mock = mockClient(S3Client);

process.env.MEDIA_STORAGE_S3_BUCKET = 'test-bucket';

const { storeMedia, retrieveMedia, buildStorageReference } = await import('../src/media/s3EncryptedMediaStorage.js');

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** aws-sdk-client-mock needs a real SDK-shaped stream body for GetObjectCommand responses, not a plain string. */
function bodyFor(text: string) {
  return sdkStreamMixin(Readable.from([Buffer.from(text)]));
}

describe('S3EncryptedMediaStorage (mocked S3-compatible client, real AES-256-GCM envelope)', () => {
  beforeAll(() => {
    // A real MASTER_ENCRYPTION_KEY must already be configured by the test
    // environment (same requirement localEncryptedMediaStorage.test.ts relies
    // on implicitly via getEncryptionService()) - not set here, reused as-is.
  });

  afterEach(() => {
    s3Mock.reset();
  });

  it('stores real encrypted bytes via PutObject, keyed by <businessId>/<sha256>.enc', async () => {
    s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('not found'), { name: 'NotFound' }));
    s3Mock.on(PutObjectCommand).resolves({});

    const businessId = randomUUID();
    const plaintext = randomBytes(4096);
    const sha256 = sha256Hex(plaintext);

    const reference = await storeMedia(businessId, sha256, plaintext);

    expect(reference).toBe(buildStorageReference(businessId, sha256));
    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.args[0].input.Bucket).toBe('test-bucket');
    expect(putCalls[0]?.args[0].input.Key).toBe(`${businessId}/${sha256}.enc`);

    // The bytes actually sent must never be the plaintext - a real encrypted envelope.
    const body = putCalls[0]?.args[0].input.Body as string;
    const envelope = JSON.parse(body) as { ciphertext: string };
    expect(Buffer.from(envelope.ciphertext, 'base64').equals(plaintext)).toBe(false);
  });

  it('dedupes identical bytes for the same tenant - a HeadObject hit skips the PutObject entirely', async () => {
    s3Mock.on(HeadObjectCommand).resolves({});

    const businessId = randomUUID();
    const plaintext = randomBytes(1024);
    const sha256 = sha256Hex(plaintext);

    const reference = await storeMedia(businessId, sha256, plaintext);

    expect(reference).toBe(buildStorageReference(businessId, sha256));
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('round-trips real bytes through store then retrieve', async () => {
    const businessId = randomUUID();
    const plaintext = randomBytes(2048);
    const sha256 = sha256Hex(plaintext);

    s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('not found'), { name: 'NotFound' }));
    let storedBody = '';
    s3Mock.on(PutObjectCommand).callsFake((input) => {
      storedBody = input.Body as string;
      return {};
    });

    const reference = await storeMedia(businessId, sha256, plaintext);

    s3Mock.on(GetObjectCommand).resolves({ Body: bodyFor(storedBody) as never });

    const retrieved = await retrieveMedia(businessId, reference);
    expect(retrieved.equals(plaintext)).toBe(true);
  });

  it('cryptographically refuses to decrypt one tenant\'s media with another tenant\'s key', async () => {
    const businessA = randomUUID();
    const businessB = randomUUID();
    const plaintext = randomBytes(512);
    const sha256 = sha256Hex(plaintext);

    s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('not found'), { name: 'NotFound' }));
    let storedBody = '';
    s3Mock.on(PutObjectCommand).callsFake((input) => {
      storedBody = input.Body as string;
      return {};
    });
    const referenceOwnedByA = await storeMedia(businessA, sha256, plaintext);

    s3Mock.on(GetObjectCommand).resolves({ Body: bodyFor(storedBody) as never });
    await expect(retrieveMedia(businessB, referenceOwnedByA)).rejects.toThrow();
  });

  it('refuses to resolve a storage reference that is not a real UUID/sha256 pair (path/key-traversal guard)', async () => {
    await expect(retrieveMedia('not-a-uuid', 'irrelevant')).rejects.toThrow();
    await expect(retrieveMedia(randomUUID(), '../../../etc/passwd')).rejects.toThrow();
    // Guarded before any S3 call is ever made.
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('throws rather than fabricating bytes when the underlying object genuinely does not exist', async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('no such key'), { name: 'NoSuchKey' }));

    const businessId = randomUUID();
    const fakeSha256 = 'a'.repeat(64);
    await expect(retrieveMedia(businessId, buildStorageReference(businessId, fakeSha256))).rejects.toThrow();
  });
});
