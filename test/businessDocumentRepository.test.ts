import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { BusinessDocumentRepository } from '../src/repositories/businessDocumentRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Phase B, D1 adversarial suite (repository layer). Every scoped method
 * on this repository must treat a cross-tenant id exactly like a
 * nonexistent one - no document metadata, no version metadata, no
 * mutation, no existence signal.
 */
describe('BusinessDocumentRepository (real Postgres, D1 tenant isolation)', () => {
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Business A');
    userId = await createTestUser(businessId);
  });

  async function createDocumentWithVersion(repo: BusinessDocumentRepository, bizId: string, uId: string, filename = 'catalogue.pdf') {
    const document = await repo.create({ businessId: bizId, createdBy: uId, filename });
    const version = await repo.createVersion({
      businessId: bizId,
      documentId: document.id,
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      mimeType: 'application/pdf',
      mimeFamily: 'pdf',
      fileSize: 1024,
      storageReference: `${bizId}/${'a'.repeat(64)}`,
    });
    await repo.setCurrentVersion(bizId, document.id, version.id);
    return { document, version };
  }

  it('creates a real document + version, with current_version_id pointing at it', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { document, version } = await createDocumentWithVersion(repo, businessId, userId);

    const found = await repo.findByIdForBusiness(document.id, businessId);
    expect(found?.currentVersionId).toBe(version.id);
    expect(found?.status).toBe('uploaded');
    expect(found?.aiRetrievable).toBe(false);
    expect(found?.aiSendable).toBe(false);
    expect(found?.customerVisible).toBe(false);
    expect(found?.humanOnly).toBe(false);
  });

  it('1. Cross-tenant document lookup: business B requesting business A\'s document gets null, no metadata leak', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { document } = await createDocumentWithVersion(repo, businessId, userId);

    const otherBusinessId = await createTestBusiness('Business B');
    const crossTenant = await repo.findByIdForBusiness(document.id, otherBusinessId);
    const genuinelyMissing = await repo.findByIdForBusiness('00000000-0000-0000-0000-000000000000', otherBusinessId);

    expect(crossTenant).toBeNull();
    expect(genuinelyMissing).toBeNull();
    // Same shape as a nonexistent id - no field of the real row leaks through a partial result.
    expect(crossTenant).toEqual(genuinelyMissing);
  });

  it('cross-tenant version lookup is denied the same way', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { version } = await createDocumentWithVersion(repo, businessId, userId);

    const otherBusinessId = await createTestBusiness('Business B');
    expect(await repo.findVersionForBusiness(version.id, otherBusinessId)).toBeNull();
    expect(await repo.findVersionForBusiness(version.id, businessId)).not.toBeNull();
  });

  it('2. Cross-tenant mutation: business B soft-deleting business A\'s document affects zero rows, no leak', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { document } = await createDocumentWithVersion(repo, businessId, userId);

    const otherBusinessId = await createTestBusiness('Business B');
    const removed = await repo.softDeleteForBusiness(document.id, otherBusinessId);
    expect(removed).toBe(false);

    const stillThere = await repo.findByIdForBusiness(document.id, businessId);
    expect(stillThere?.deletedAt).toBeNull();
  });

  it('a real owner\'s own soft delete succeeds, and the document then reads as gone for that owner too', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { document } = await createDocumentWithVersion(repo, businessId, userId);

    const removed = await repo.softDeleteForBusiness(document.id, businessId);
    expect(removed).toBe(true);
    expect(await repo.findByIdForBusiness(document.id, businessId)).toBeNull();

    // The underlying row still physically exists (soft delete, not a hard DELETE) - only visibility changed.
    const { rows } = await pool.query('SELECT deleted_at FROM business_documents WHERE id = $1', [document.id]);
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it('3. ID substitution: a real document id from business A, paired with business B, is structurally denied at the repository boundary', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { document, version } = await createDocumentWithVersion(repo, businessId, userId);
    const otherBusinessId = await createTestBusiness('Business B');
    const otherUserId = await createTestUser(otherBusinessId);

    // A cell/worker/service that received business A's real ids but is
    // (correctly or by attack) executing as business B must never see them.
    expect(await repo.findByIdForBusiness(document.id, otherBusinessId)).toBeNull();
    expect(await repo.findVersionForBusiness(version.id, otherBusinessId)).toBeNull();
    expect(await repo.softDeleteForBusiness(document.id, otherBusinessId)).toBe(false);

    // Business B's own real document, meanwhile, works normally under its own id - this isn't a broken repository, it's a real boundary.
    const own = await createDocumentWithVersion(repo, otherBusinessId, otherUserId, 'brochure.pdf');
    expect((await repo.findByIdForBusiness(own.document.id, otherBusinessId))?.id).toBe(own.document.id);
  });

  it('listForBusiness and countByBusiness never include another business\'s documents', async () => {
    const repo = new BusinessDocumentRepository(pool);
    await createDocumentWithVersion(repo, businessId, userId, 'a.pdf');
    await createDocumentWithVersion(repo, businessId, userId, 'b.pdf');

    const otherBusinessId = await createTestBusiness('Business B');
    const otherUserId = await createTestUser(otherBusinessId);
    await createDocumentWithVersion(repo, otherBusinessId, otherUserId, 'c.pdf');

    expect(await repo.countByBusiness(businessId)).toBe(2);
    expect(await repo.countByBusiness(otherBusinessId)).toBe(1);

    const listA = await repo.listForBusiness(businessId);
    expect(listA).toHaveLength(2);
    expect(listA.every((d) => d.businessId === businessId)).toBe(true);
  });

  it('listForBusiness excludes soft-deleted documents', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { document } = await createDocumentWithVersion(repo, businessId, userId);
    await repo.softDeleteForBusiness(document.id, businessId);

    expect(await repo.listForBusiness(businessId)).toHaveLength(0);
    expect(await repo.countByBusiness(businessId)).toBe(0);
  });

  it('5. Database integrity: version_number is unique per document', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const document = await repo.create({ businessId, createdBy: userId, filename: 'x.pdf' });
    await repo.createVersion({
      businessId,
      documentId: document.id,
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      mimeType: 'application/pdf',
      mimeFamily: 'pdf',
      fileSize: 10,
      storageReference: `${businessId}/${'a'.repeat(64)}`,
    });

    await expect(
      repo.createVersion({
        businessId,
        documentId: document.id,
        versionNumber: 1,
        checksum: 'b'.repeat(64),
        mimeType: 'application/pdf',
        mimeFamily: 'pdf',
        fileSize: 20,
        storageReference: `${businessId}/${'b'.repeat(64)}`,
      }),
    ).rejects.toThrow();
  });

  it('5. Database integrity: business_documents.business_id foreign key is enforced', async () => {
    await expect(
      pool.query(
        `INSERT INTO business_documents (business_id, created_by, filename) VALUES ($1, $2, 'x.pdf')`,
        ['00000000-0000-0000-0000-000000000000', userId],
      ),
    ).rejects.toThrow();
  });

  it('5. Database integrity: fail-closed classification defaults, and the CHECK constraints reject contradictory combinations', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const document = await repo.create({ businessId, createdBy: userId, filename: 'x.pdf' });
    expect(document.aiRetrievable).toBe(false);
    expect(document.aiSendable).toBe(false);
    expect(document.customerVisible).toBe(false);
    expect(document.humanOnly).toBe(false);

    // human_only cannot coexist with either AI flag.
    await expect(
      pool.query('UPDATE business_documents SET human_only = true, ai_retrievable = true WHERE id = $1', [document.id]),
    ).rejects.toThrow();

    // ai_sendable implies ai_retrievable - cannot be sendable without being retrievable.
    await expect(
      pool.query('UPDATE business_documents SET ai_sendable = true, ai_retrievable = false WHERE id = $1', [document.id]),
    ).rejects.toThrow();
  });

  it('5. Database integrity: deleting a business cascades to its documents and versions - no orphaned cross-tenant references survive', async () => {
    const repo = new BusinessDocumentRepository(pool);
    const { document, version } = await createDocumentWithVersion(repo, businessId, userId);

    await pool.query('DELETE FROM businesses WHERE id = $1', [businessId]);

    const { rows: docRows } = await pool.query('SELECT id FROM business_documents WHERE id = $1', [document.id]);
    const { rows: versionRows } = await pool.query('SELECT id FROM business_document_versions WHERE id = $1', [version.id]);
    expect(docRows).toHaveLength(0);
    expect(versionRows).toHaveLength(0);
  });
});
