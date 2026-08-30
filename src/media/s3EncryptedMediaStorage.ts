import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getEncryptionService } from '../security/encryption/index.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Real object storage backed by an S3-compatible bucket (Tigris on Fly.io;
 * any other S3-compatible provider works identically). Same encryption
 * model as localEncryptedMediaStorage.ts - files are AES-256-GCM encrypted
 * at rest via EncryptionService's per-tenant key derivation before the
 * bytes ever leave this process, so the bucket itself never holds
 * plaintext regardless of the provider's own at-rest guarantees. Exists so
 * app-server and app-worker (two separate machines/containers in the
 * cloud) can share one media store - a local Fly volume is tied to a
 * single machine and cannot be mounted read/write by both.
 *
 * The exported interface (buildStorageReference/storeMedia/retrieveMedia)
 * is identical to localEncryptedMediaStorage.ts on purpose - every real
 * call site imports from the neutral mediaStorage.ts dispatcher and never
 * knows which backend is actually in use.
 */

let client: S3Client | null = null;

/**
 * Lazily constructed, same reasoning as getEncryptionService(): a missing
 * BUCKET_NAME/credentials only fails when media storage is actually used,
 * not at process boot - most local/dev/test runs never touch this backend
 * at all (MEDIA_STORAGE_BACKEND defaults to 'local').
 *
 * No explicit endpoint/region/credentials passed unless overridden - the
 * AWS SDK v3 reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
 * and the S3-specific AWS_ENDPOINT_URL_S3 from the environment
 * automatically. This is the exact set of secrets `fly storage create`
 * (Tigris) provisions - real evidence this works untouched is a live Fly
 * deploy, not independently re-verified in this environment.
 */
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      // Tigris (and most S3-compatible providers) work with virtual-hosted
      // addressing, but forcePathStyle is a documented, low-risk safety net
      // for providers/proxies that don't - explicit here rather than left
      // to whatever the SDK's own default happens to be.
      forcePathStyle: process.env.MEDIA_STORAGE_S3_FORCE_PATH_STYLE === 'true',
    });
  }
  return client;
}

function bucketName(): string {
  const bucket = process.env.MEDIA_STORAGE_S3_BUCKET ?? process.env.BUCKET_NAME;
  if (!bucket) {
    throw new Error('MEDIA_STORAGE_S3_BUCKET (or BUCKET_NAME) must be set to use the S3-backed media storage.');
  }
  return bucket;
}

export function buildStorageReference(businessId: string, sha256: string): string {
  return `${businessId}/${sha256}`;
}

function resolveSafeKey(storageReference: string): string {
  const [businessId, sha256] = storageReference.split('/');
  if (!businessId || !sha256 || !UUID_PATTERN.test(businessId) || !SHA256_PATTERN.test(sha256)) {
    throw new Error(`Refusing to resolve an unsafe media storage reference: ${storageReference}`);
  }
  return `${businessId}/${sha256}.enc`;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'NotFound') return false;
    throw error;
  }
}

async function streamToString(body: unknown): Promise<string> {
  // The SDK's Body type varies by runtime (Node stream vs web ReadableStream
  // vs Blob) - transformToString() is the SDK's own runtime-agnostic helper
  // for exactly this, present on every real response body it returns.
  const stream = body as { transformToString(): Promise<string> };
  return stream.transformToString();
}

/**
 * Encrypts and writes `plaintext`, deduping by sha256 within the tenant -
 * same contract as localEncryptedMediaStorage.ts's storeMedia(). A single
 * S3 PutObject is already atomic (an object is only ever visible once
 * fully uploaded, never partially) - unlike the local-disk backend, no
 * temp-object-then-rename dance is needed to avoid a corrupt dedup cache
 * hit from an interrupted write.
 */
export async function storeMedia(businessId: string, sha256: string, plaintext: Buffer): Promise<string> {
  const reference = buildStorageReference(businessId, sha256);
  const key = resolveSafeKey(reference);

  if (await objectExists(key)) return reference; // Real dedup - identical bytes already stored for this tenant.

  const envelope = await getEncryptionService().encryptBuffer(businessId, plaintext);
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: JSON.stringify(envelope),
      ContentType: 'application/json',
    }),
  );
  return reference;
}

export async function retrieveMedia(businessId: string, storageReference: string): Promise<Buffer> {
  const key = resolveSafeKey(storageReference);
  const response = await getClient().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  const raw = await streamToString(response.Body);
  const envelope = getEncryptionService().tryParse(raw);
  if (!envelope) throw new Error(`Stored media at ${storageReference} is not a valid encrypted envelope`);
  return getEncryptionService().decryptBuffer(businessId, envelope);
}
