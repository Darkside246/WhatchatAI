import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import {
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  downloadDocument,
  isInvalidDocumentError,
  isDocumentNotFoundError,
} from '../src/services/documentService.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { isEntitlementDeniedError } from '../src/services/workspaceService.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('documentService (Phase B, D1 - real Postgres + real encrypted storage, no fabricated results)', () => {
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    userId = owner.user.id;
  });

  it('uploads, lists, gets, downloads (real decrypted round-trip), and soft-deletes a real document', async () => {
    const content = 'Real catalogue content for the upload/download round trip.';
    const { document, version } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'catalogue.pdf',
      mimeType: 'application/pdf',
      fileBase64: toBase64(content),
    });

    expect(document.status).toBe('uploaded');
    expect(document.currentVersionId).toBe(version.id);
    expect(version.mimeFamily).toBe('pdf');
    expect(version.checksum).toHaveLength(64);

    const listed = await listDocuments(businessId);
    expect(listed.map((d) => d.id)).toContain(document.id);

    const fetched = await getDocument(businessId, document.id);
    expect(fetched.filename).toBe('catalogue.pdf');

    const downloaded = await downloadDocument(businessId, document.id);
    expect(downloaded.buffer.toString('utf8')).toBe(content);

    // The file on disk is genuinely encrypted, not merely obfuscated by
    // the service abstraction - the raw stored bytes never contain the
    // plaintext substring.
    const storagePath = path.resolve(
      process.env.MEDIA_STORAGE_DIR ?? './data/media-storage',
      businessId,
      `${version.checksum}.enc`,
    );
    const rawStoredFile = await readFile(storagePath, 'utf8');
    expect(rawStoredFile).not.toContain(content);

    await deleteDocument(businessId, document.id, userId);
    await expect(getDocument(businessId, document.id)).rejects.toSatisfy(isDocumentNotFoundError);
    expect(await listDocuments(businessId)).toHaveLength(0);
  });

  it('rejects a disallowed MIME type before storing anything, and audits the block (never the file content)', async () => {
    await expect(
      uploadDocument({
        businessId,
        createdBy: userId,
        filename: 'photo.png',
        mimeType: 'image/png',
        fileBase64: toBase64('not a document'),
      }),
    ).rejects.toSatisfy(isInvalidDocumentError);

    expect(await listDocuments(businessId)).toHaveLength(0);

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    const blocked = log.find((entry) => entry.eventType === 'business_document_upload_blocked');
    expect(blocked).toBeDefined();
    expect(blocked?.reason).toMatch(/Unsupported document type/);
    expect(JSON.stringify(blocked?.rawMetadata)).not.toContain('not a document');
  });

  it('normalizes a MIME parameter before comparing - "application/pdf; charset=utf-8" is accepted exactly like "application/pdf"', async () => {
    const { document } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'catalogue.pdf',
      mimeType: 'application/pdf; charset=utf-8',
      fileBase64: toBase64('real content'),
    });
    expect(document.id).toBeDefined();
  });

  it('a MIME-parameter bypass attempt for a disallowed type is still rejected - normalization does not widen the allow-list', async () => {
    await expect(
      uploadDocument({
        businessId,
        createdBy: userId,
        filename: 'photo.png',
        mimeType: 'image/png; charset=binary',
        fileBase64: toBase64('not a document'),
      }),
    ).rejects.toSatisfy(isInvalidDocumentError);
  });

  it('rejects an executable-shaped filename even under an otherwise-allowed MIME type, and audits the block (heuristicShield reused, not weakened)', async () => {
    await expect(
      uploadDocument({
        businessId,
        createdBy: userId,
        filename: 'invoice.exe',
        mimeType: 'application/pdf',
        fileBase64: toBase64('irrelevant'),
      }),
    ).rejects.toSatisfy(isInvalidDocumentError);

    expect(await listDocuments(businessId)).toHaveLength(0);
    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    const blocked = log.find((entry) => entry.eventType === 'business_document_upload_blocked');
    expect(blocked?.reason).toMatch(/executable file extension/);
  });

  it('rejects an empty filename, an oversized filename, and an empty file - never storing anything', async () => {
    await expect(
      uploadDocument({ businessId, createdBy: userId, filename: '   ', mimeType: 'application/pdf', fileBase64: toBase64('x') }),
    ).rejects.toSatisfy(isInvalidDocumentError);
    await expect(
      uploadDocument({
        businessId,
        createdBy: userId,
        filename: 'a'.repeat(256),
        mimeType: 'application/pdf',
        fileBase64: toBase64('x'),
      }),
    ).rejects.toSatisfy(isInvalidDocumentError);
    await expect(
      uploadDocument({ businessId, createdBy: userId, filename: 'empty.pdf', mimeType: 'application/pdf', fileBase64: '' }),
    ).rejects.toSatisfy(isInvalidDocumentError);

    expect(await listDocuments(businessId)).toHaveLength(0);
  });

  it('enforces the real per-plan max_business_documents entitlement - a new business defaults to the Starter plan (limit 10)', async () => {
    for (let i = 0; i < 10; i += 1) {
      await uploadDocument({
        businessId,
        createdBy: userId,
        filename: `doc-${i}.txt`,
        mimeType: 'text/plain',
        fileBase64: toBase64(`content ${i}`),
      });
    }
    await expect(
      uploadDocument({ businessId, createdBy: userId, filename: 'doc-11.txt', mimeType: 'text/plain', fileBase64: toBase64('one too many') }),
    ).rejects.toSatisfy(isEntitlementDeniedError);
    try {
      await uploadDocument({ businessId, createdBy: userId, filename: 'doc-11.txt', mimeType: 'text/plain', fileBase64: toBase64('one too many') });
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) expect(error.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
    }
  });

  it('refuses to get, download, or delete a document belonging to a different business - not found, not access-denied, no leak', async () => {
    const { document } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'private.pdf',
      mimeType: 'application/pdf',
      fileBase64: toBase64('Business A private catalogue content - must never leave this tenant.'),
    });

    const otherBusinessId = await createTestBusiness('Other Business');
    const otherUserId = await createTestUser(otherBusinessId);

    await expect(getDocument(otherBusinessId, document.id)).rejects.toSatisfy(isDocumentNotFoundError);
    await expect(downloadDocument(otherBusinessId, document.id)).rejects.toSatisfy(isDocumentNotFoundError);
    await expect(deleteDocument(otherBusinessId, document.id, otherUserId)).rejects.toSatisfy(isDocumentNotFoundError);

    // Untouched - still there, still retrievable by its real owner.
    const stillOurs = await getDocument(businessId, document.id);
    expect(stillOurs.id).toBe(document.id);
    expect(stillOurs.deletedAt).toBeNull();
  });

  it('successful upload and delete each write a real, business-scoped audit event with no document content', async () => {
    const { document } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'sensitive.pdf',
      mimeType: 'application/pdf',
      fileBase64: toBase64('Confidential pricing information - must never appear in an audit log.'),
    });
    await deleteDocument(businessId, document.id, userId);

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId, 10);
    const uploaded = log.find((entry) => entry.eventType === 'business_document_uploaded');
    const deleted = log.find((entry) => entry.eventType === 'business_document_deleted');
    expect(uploaded).toBeDefined();
    expect(deleted).toBeDefined();
    expect(JSON.stringify(uploaded?.rawMetadata)).not.toContain('Confidential pricing');
    expect(JSON.stringify(deleted?.rawMetadata)).not.toContain('Confidential pricing');
  });
});
