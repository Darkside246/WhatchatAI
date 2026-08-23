import { mkdir, readFile, writeFile, access, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { getEncryptionService } from '../security/encryption/index.js';

const MEDIA_STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR ?? './data/media-storage');
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Real local-disk media storage: files are AES-256-GCM encrypted at rest
 * (reusing EncryptionService's per-tenant key derivation - the same DEK a
 * tenant's text fields use), tenant-isolated by directory, and deduped by
 * sha256 so identical bytes are never physically stored twice for the same
 * tenant. Never serves a raw filesystem path to a client - see
 * GET /api/media/:id, which is the only thing that reads through this.
 */
export function buildStorageReference(businessId: string, sha256: string): string {
  return `${businessId}/${sha256}`;
}

function resolveSafePath(storageReference: string): string {
  const [businessId, sha256] = storageReference.split('/');
  if (!businessId || !sha256 || !UUID_PATTERN.test(businessId) || !SHA256_PATTERN.test(sha256)) {
    throw new Error(`Refusing to resolve an unsafe media storage reference: ${storageReference}`);
  }
  return path.join(MEDIA_STORAGE_DIR, businessId, `${sha256}.enc`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts and writes `plaintext`, deduping by sha256 within the tenant.
 * Returns the storage reference to persist on the media row.
 *
 * Writes to a temp file and rename()s it into place (Phase 2B fix, see
 * docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md section 7): a crash or
 * thrown error mid-write previously could leave a truncated file at the
 * final, content-addressed path - fileExists()'s dedup check treats that
 * corrupt file as a valid cache hit forever after, permanently poisoning
 * that sha256 for the tenant. rename() on the same filesystem is atomic, so
 * the final path only ever holds a complete write; an interrupted attempt
 * leaves nothing but an orphaned `.tmp-*` file.
 */
export async function storeMedia(businessId: string, sha256: string, plaintext: Buffer): Promise<string> {
  const reference = buildStorageReference(businessId, sha256);
  const filePath = resolveSafePath(reference);

  if (await fileExists(filePath)) return reference; // Real dedup - identical bytes already stored for this tenant.

  await mkdir(path.dirname(filePath), { recursive: true });
  const envelope = await getEncryptionService().encryptBuffer(businessId, plaintext);
  const tempPath = `${filePath}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(tempPath, JSON.stringify(envelope), { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {}); // Best-effort cleanup - a failed write must not leave a stray temp file behind.
    throw error;
  }
  return reference;
}

export async function retrieveMedia(businessId: string, storageReference: string): Promise<Buffer> {
  const filePath = resolveSafePath(storageReference);
  const raw = await readFile(filePath, 'utf8');
  const envelope = getEncryptionService().tryParse(raw);
  if (!envelope) throw new Error(`Stored media at ${storageReference} is not a valid encrypted envelope`);
  return getEncryptionService().decryptBuffer(businessId, envelope);
}
