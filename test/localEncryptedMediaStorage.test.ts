import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Only `rename` is overridden below (Phase 2B atomic-write test) - every
// other real disk I/O in this file stays real. Defaults to delegating to
// the actual implementation, so every test except the one that explicitly
// arms a rejection still exercises real rename() behavior. vi.hoisted is
// required here (not a plain top-level const) because vi.mock itself is
// hoisted above ordinary statements, and this file also statically imports
// from 'node:fs/promises' for its own use.
const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => renameMock(...args) };
});

const { storeMedia, retrieveMedia, buildStorageReference } = await import('../src/media/localEncryptedMediaStorage.js');

const MEDIA_STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR ?? './data/media-storage');
const createdBusinessIds: string[] = [];

function trackedBusinessId(): string {
  const id = randomUUID();
  createdBusinessIds.push(id);
  return id;
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('LocalEncryptedMediaStorage (real disk I/O, real AES-256-GCM at rest)', () => {
  afterAll(async () => {
    await Promise.all(
      createdBusinessIds.map((id) => rm(path.join(MEDIA_STORAGE_DIR, id), { recursive: true, force: true })),
    );
  });

  it('writes real bytes to a real encrypted file on disk and reads back the exact original bytes', async () => {
    const businessId = trackedBusinessId();
    const plaintext = randomBytes(8192); // stands in for a real downloaded media file
    const sha256 = sha256Hex(plaintext);

    const reference = await storeMedia(businessId, sha256, plaintext);
    expect(reference).toBe(buildStorageReference(businessId, sha256));

    const filePath = path.join(MEDIA_STORAGE_DIR, businessId, `${sha256}.enc`);
    const rawOnDisk = await readFile(filePath, 'utf8');
    const envelope = JSON.parse(rawOnDisk) as { ciphertext: string };
    // The bytes actually on disk must never be the plaintext.
    expect(Buffer.from(envelope.ciphertext, 'base64').equals(plaintext)).toBe(false);

    const retrieved = await retrieveMedia(businessId, reference);
    expect(retrieved.equals(plaintext)).toBe(true);
  });

  it('dedupes identical bytes for the same tenant - storing twice writes the file only once', async () => {
    const businessId = trackedBusinessId();
    const plaintext = randomBytes(2048);
    const sha256 = sha256Hex(plaintext);

    const first = await storeMedia(businessId, sha256, plaintext);
    const filePath = path.join(MEDIA_STORAGE_DIR, businessId, `${sha256}.enc`);
    const firstWriteTime = (await stat(filePath)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await storeMedia(businessId, sha256, plaintext);
    const secondWriteTime = (await stat(filePath)).mtimeMs;

    expect(second).toBe(first);
    expect(secondWriteTime).toBe(firstWriteTime); // file was never rewritten - real dedup, not just an equal reference

    const retrieved = await retrieveMedia(businessId, second);
    expect(retrieved.equals(plaintext)).toBe(true);
  });

  it('isolates tenants on disk - two businesses storing identical bytes get separate encrypted files', async () => {
    const businessA = trackedBusinessId();
    const businessB = trackedBusinessId();
    const plaintext = randomBytes(512);
    const sha256 = sha256Hex(plaintext);

    const refA = await storeMedia(businessA, sha256, plaintext);
    const refB = await storeMedia(businessB, sha256, plaintext);

    expect(refA).not.toBe(refB);

    const bytesA = await readFile(path.join(MEDIA_STORAGE_DIR, businessA, `${sha256}.enc`), 'utf8');
    const bytesB = await readFile(path.join(MEDIA_STORAGE_DIR, businessB, `${sha256}.enc`), 'utf8');
    expect(bytesA).not.toBe(bytesB); // different tenant DEKs -> different ciphertext/IV for identical plaintext
  });

  it('cryptographically refuses to decrypt one tenant\'s media file with another tenant\'s key', async () => {
    const businessA = trackedBusinessId();
    const businessB = trackedBusinessId();
    const plaintext = randomBytes(1024);
    const sha256 = sha256Hex(plaintext);

    const referenceOwnedByA = await storeMedia(businessA, sha256, plaintext);

    // Same on-disk reference, but decrypted as if it belonged to tenant B -
    // the real GCM auth tag must reject this, not just return garbage.
    await expect(retrieveMedia(businessB, referenceOwnedByA)).rejects.toThrow();
  });

  it('refuses to resolve a storage reference that is not a real UUID/sha256 pair (path traversal guard)', async () => {
    await expect(retrieveMedia('not-a-uuid', 'irrelevant')).rejects.toThrow();
    await expect(retrieveMedia(randomUUID(), '../../../etc/passwd')).rejects.toThrow();
    await expect(retrieveMedia(randomUUID(), `../../etc/passwd/${'a'.repeat(64)}`)).rejects.toThrow();
  });

  it('throws rather than fabricating bytes when the underlying file genuinely does not exist', async () => {
    const businessId = trackedBusinessId();
    const fakeSha256 = 'a'.repeat(64);
    await expect(retrieveMedia(businessId, buildStorageReference(businessId, fakeSha256))).rejects.toThrow();
  });

  /**
   * Phase 2B: closes the defect docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md
   * section 7 found - storeMedia() used to writeFile() directly to its final,
   * content-addressed path with no temp-file-then-rename, so a crash or
   * thrown error mid-write could leave a truncated file there. fileExists()'s
   * dedup check would then treat that corrupt file as a valid cache hit
   * forever after, permanently poisoning that sha256 for the tenant. This
   * forces a real rename() failure (the actual OS call the fix relies on) to
   * prove the interruption leaves nothing at the final path.
   */
  it('a write failure leaves no corrupt file at the final path and no dangling temp file', async () => {
    const businessId = trackedBusinessId();
    const plaintext = randomBytes(512);
    const sha256 = sha256Hex(plaintext);

    renameMock.mockImplementationOnce(async () => {
      throw new Error('simulated crash during rename');
    });

    await expect(storeMedia(businessId, sha256, plaintext)).rejects.toThrow('simulated crash during rename');

    const dirEntries = await readdir(path.join(MEDIA_STORAGE_DIR, businessId)).catch(() => []);
    expect(dirEntries).not.toContain(`${sha256}.enc`); // never a corrupt file at the final, content-addressed path
    expect(dirEntries.filter((name) => name.includes('.tmp-'))).toHaveLength(0); // the catch/unlink cleanup removed it
  });

  it('a retry after an interrupted write succeeds cleanly - no poisoned dedup entry from the earlier failure', async () => {
    const businessId = trackedBusinessId();
    const plaintext = randomBytes(512);
    const sha256 = sha256Hex(plaintext);

    renameMock.mockImplementationOnce(async () => {
      throw new Error('simulated crash during rename');
    });
    await expect(storeMedia(businessId, sha256, plaintext)).rejects.toThrow();

    // A subsequent real attempt (no interruption this time) must succeed -
    // this is exactly what the old bug made permanently impossible (the
    // corrupt file at the final path satisfied fileExists() forever after).
    const reference = await storeMedia(businessId, sha256, plaintext);
    const retrieved = await retrieveMedia(businessId, reference);
    expect(retrieved.equals(plaintext)).toBe(true);
  });
});
