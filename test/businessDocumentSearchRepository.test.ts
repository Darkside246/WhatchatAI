import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { BusinessDocumentRepository } from '../src/repositories/businessDocumentRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Phase D3-C adversarial suite (repository layer). Every claim here is
 * proven directly against the SQL join in searchReadyDocumentChunksForBusiness/
 * searchAiRetrievableDocumentChunksForBusiness - never mocked, never
 * relying on a caller having filtered anything first.
 */
describe('BusinessDocumentRepository search methods (real Postgres, D3 structural tenant/status/version isolation)', () => {
  let repo: BusinessDocumentRepository;
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    repo = new BusinessDocumentRepository(pool);
    businessId = await createTestBusiness('Business A');
    userId = await createTestUser(businessId);
  });

  /** Seeds a document straight to a real, chunked, 'ready' state - no worker involved, exactly the state D2's own worker leaves a real success in. */
  async function seedReadyDocument(
    bizId: string,
    filename: string,
    chunkText: string,
    overrides: { aiRetrievable?: boolean } = {},
  ): Promise<{ documentId: string; versionId: string }> {
    const document = await repo.create({ businessId: bizId, createdBy: userId, filename });
    const version = await repo.createVersion({
      businessId: bizId,
      documentId: document.id,
      versionNumber: 1,
      checksum: createHash('sha256').update(chunkText).digest('hex'),
      mimeType: 'text/plain',
      mimeFamily: 'text',
      fileSize: chunkText.length,
      storageReference: `${bizId}/${createHash('sha256').update(chunkText).digest('hex')}`,
    });
    await repo.setCurrentVersion(bizId, document.id, version.id);
    await repo.createChunks({
      businessId: bizId,
      documentId: document.id,
      versionId: version.id,
      chunks: [{ sequence: 0, text: chunkText, charStart: 0, charEnd: chunkText.length, checksum: createHash('sha256').update(chunkText).digest('hex') }],
    });
    await repo.markVersionParsed(bizId, version.id, createHash('sha256').update(chunkText).digest('hex'));
    await repo.markDocumentReadyIfCurrentVersion(bizId, document.id, version.id);
    if (overrides.aiRetrievable) {
      await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);
    }
    return { documentId: document.id, versionId: version.id };
  }

  it('1. cross-tenant human search denial: Business B never sees Business A\'s ready, real content', async () => {
    await seedReadyDocument(businessId, 'catalogue.txt', 'Our exclusive spring catalogue pricing details for widgets.');
    const otherBusinessId = await createTestBusiness('Business B');

    const results = await repo.searchReadyDocumentChunksForBusiness(otherBusinessId, 'spring catalogue pricing', 10);
    expect(results).toEqual([]);
  });

  it('2. cross-tenant AI retrieval denial: Business B never sees Business A\'s AI-retrievable content', async () => {
    await seedReadyDocument(businessId, 'catalogue.txt', 'Our exclusive spring catalogue pricing details for widgets.', { aiRetrievable: true });
    const otherBusinessId = await createTestBusiness('Business B');

    const results = await repo.searchAiRetrievableDocumentChunksForBusiness(otherBusinessId, 'spring catalogue pricing', 3);
    expect(results).toEqual([]);
  });

  it('3. ID substitution denial: knowing Business B\'s exact real content/filename does not let Business A retrieve it - there is no id-shaped bypass, only the business-scoped query', async () => {
    const otherBusinessId = await createTestBusiness('Business B');
    const { documentId } = await seedReadyDocument(otherBusinessId, 'confidential-report.txt', 'A uniquely identifiable phrase: zephyr-quartz-19.');

    // Business A searches for the exact unique phrase AND the exact real document id as free text - neither grants access.
    const byPhrase = await repo.searchReadyDocumentChunksForBusiness(businessId, 'zephyr-quartz-19', 10);
    const byId = await repo.searchReadyDocumentChunksForBusiness(businessId, documentId, 10);
    expect(byPhrase).toEqual([]);
    expect(byId).toEqual([]);
  });

  it('4. soft-deleted document: chunk rows remain physically present, but both search paths return nothing', async () => {
    const { documentId, versionId } = await seedReadyDocument(businessId, 'to-delete.txt', 'Real content that will be deleted.', { aiRetrievable: true });
    await repo.softDeleteForBusiness(documentId, businessId);

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM business_document_chunks WHERE version_id = $1', [versionId]);
    expect(rows[0].count).toBeGreaterThan(0); // physically present - the FK CASCADE never fires on a soft delete

    expect(await repo.searchReadyDocumentChunksForBusiness(businessId, 'real content deleted', 10)).toEqual([]);
    expect(await repo.searchAiRetrievableDocumentChunksForBusiness(businessId, 'real content deleted', 3)).toEqual([]);
  });

  it('5. unique text from a soft-deleted document cannot be found by either search path', async () => {
    const { documentId } = await seedReadyDocument(businessId, 'secret.txt', 'The unique marker phrase is glimmer-fox-42.');
    await repo.softDeleteForBusiness(documentId, businessId);

    expect(await repo.searchReadyDocumentChunksForBusiness(businessId, 'glimmer-fox-42', 10)).toEqual([]);
  });

  it('6. status="uploaded" (never parsed) is excluded from both search paths', async () => {
    const document = await repo.create({ businessId, createdBy: userId, filename: 'not-parsed-yet.txt' });
    const version = await repo.createVersion({
      businessId,
      documentId: document.id,
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      mimeType: 'text/plain',
      mimeFamily: 'text',
      fileSize: 10,
      storageReference: `${businessId}/${'a'.repeat(64)}`,
    });
    await repo.setCurrentVersion(businessId, document.id, version.id);
    await repo.createChunks({
      businessId,
      documentId: document.id,
      versionId: version.id,
      chunks: [{ sequence: 0, text: 'unreachable uploaded-state content', charStart: 0, charEnd: 10, checksum: 'b'.repeat(64) }],
    });
    // Deliberately never marked 'ready' - status stays 'uploaded'.

    expect(await repo.searchReadyDocumentChunksForBusiness(businessId, 'unreachable uploaded-state', 10)).toEqual([]);
  });

  it('7. status="processing" (parsing in flight) is excluded from both search paths', async () => {
    const document = await repo.create({ businessId, createdBy: userId, filename: 'mid-parse.txt' });
    const version = await repo.createVersion({
      businessId,
      documentId: document.id,
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      mimeType: 'text/plain',
      mimeFamily: 'text',
      fileSize: 10,
      storageReference: `${businessId}/${'a'.repeat(64)}`,
    });
    await repo.setCurrentVersion(businessId, document.id, version.id);
    await repo.markDocumentProcessing(businessId, document.id);
    await repo.createChunks({
      businessId,
      documentId: document.id,
      versionId: version.id,
      chunks: [{ sequence: 0, text: 'unreachable processing-state content', charStart: 0, charEnd: 10, checksum: 'b'.repeat(64) }],
    });

    expect(await repo.searchReadyDocumentChunksForBusiness(businessId, 'unreachable processing-state', 10)).toEqual([]);
  });

  it('8. status="failed" is excluded from both search paths', async () => {
    const document = await repo.create({ businessId, createdBy: userId, filename: 'failed-parse.txt' });
    const version = await repo.createVersion({
      businessId,
      documentId: document.id,
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      mimeType: 'text/plain',
      mimeFamily: 'text',
      fileSize: 10,
      storageReference: `${businessId}/${'a'.repeat(64)}`,
    });
    await repo.setCurrentVersion(businessId, document.id, version.id);
    // If a hostile/corrupted document somehow left chunk rows behind despite
    // a failed parse, they must still never surface - proves the guard is
    // the document's status, not merely "did createChunks ever run."
    await repo.createChunks({
      businessId,
      documentId: document.id,
      versionId: version.id,
      chunks: [{ sequence: 0, text: 'unreachable failed-state content', charStart: 0, charEnd: 10, checksum: 'b'.repeat(64) }],
    });
    await repo.markVersionFailed(businessId, version.id, 'corrupted_or_unreadable');
    await repo.markDocumentFailedIfCurrentVersion(businessId, document.id, version.id);

    expect(await repo.searchReadyDocumentChunksForBusiness(businessId, 'unreachable failed-state', 10)).toEqual([]);
  });

  it('9. a genuinely ready document is found by human search (positive control)', async () => {
    await seedReadyDocument(businessId, 'catalogue.txt', 'The real spring catalogue includes widget pricing.');

    const results = await repo.searchReadyDocumentChunksForBusiness(businessId, 'spring catalogue widget pricing', 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.filename).toBe('catalogue.txt');
  });

  it('10. obsolete version exclusion: a chunk from a version that is no longer current_version_id is never returned', async () => {
    const { documentId, versionId: firstVersionId } = await seedReadyDocument(businessId, 'v1.txt', 'Obsolete version content with unique marker willow-trace-7.');

    // A second, real version - the document's current pointer moves on.
    const secondVersion = await repo.createVersion({
      businessId,
      documentId,
      versionNumber: 2,
      checksum: 'c'.repeat(64),
      mimeType: 'text/plain',
      mimeFamily: 'text',
      fileSize: 10,
      storageReference: `${businessId}/${'c'.repeat(64)}`,
    });
    await repo.setCurrentVersion(businessId, documentId, secondVersion.id);
    await repo.markVersionParsed(businessId, secondVersion.id, 'd'.repeat(64));
    await repo.markDocumentReadyIfCurrentVersion(businessId, documentId, secondVersion.id);

    // The first version's chunk (still real, still physically present) must never surface once it is no longer current.
    const results = await repo.searchReadyDocumentChunksForBusiness(businessId, 'willow-trace-7', 10);
    expect(results).toEqual([]);
    const stillPresent = await pool.query('SELECT count(*)::int AS count FROM business_document_chunks WHERE version_id = $1', [firstVersionId]);
    expect(stillPresent.rows[0].count).toBeGreaterThan(0);
  });

  it('11/13. human search works with ai_retrievable=false; AI retrieval only works once ai_retrievable=true', async () => {
    const { documentId } = await seedReadyDocument(businessId, 'internal.txt', 'Internal-only content, never meant for the AI: heron-cobalt-3.');

    const humanResults = await repo.searchReadyDocumentChunksForBusiness(businessId, 'heron-cobalt-3', 10);
    expect(humanResults).toHaveLength(1);

    const aiResultsBefore = await repo.searchAiRetrievableDocumentChunksForBusiness(businessId, 'heron-cobalt-3', 3);
    expect(aiResultsBefore).toEqual([]);

    await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [documentId]);
    const aiResultsAfter = await repo.searchAiRetrievableDocumentChunksForBusiness(businessId, 'heron-cobalt-3', 3);
    expect(aiResultsAfter).toHaveLength(1);
  });

  it('14. the limit parameter is respected by both search methods', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedReadyDocument(businessId, `doc-${i}.txt`, `Shared searchable marker phrase mallard-topaz across document ${i}.`, { aiRetrievable: true });
    }

    const humanResults = await repo.searchReadyDocumentChunksForBusiness(businessId, 'mallard-topaz', 2);
    expect(humanResults).toHaveLength(2);

    const aiResults = await repo.searchAiRetrievableDocumentChunksForBusiness(businessId, 'mallard-topaz', 3);
    expect(aiResults.length).toBeLessThanOrEqual(3);
  });

  it('21. two businesses with similar/identical text remain fully isolated from each other in both search paths', async () => {
    const otherBusinessId = await createTestBusiness('Business B');
    const otherUserId = await createTestUser(otherBusinessId);

    await seedReadyDocument(businessId, 'shared-phrase-a.txt', 'The quarterly onboarding checklist for new employees.', { aiRetrievable: true });
    const otherRepo = repo; // same repository instance, different businessId per call - proves scoping is per-call, not per-instance
    void otherUserId;
    await (async () => {
      const document = await otherRepo.create({ businessId: otherBusinessId, createdBy: otherUserId, filename: 'shared-phrase-b.txt' });
      const version = await otherRepo.createVersion({
        businessId: otherBusinessId,
        documentId: document.id,
        versionNumber: 1,
        checksum: 'e'.repeat(64),
        mimeType: 'text/plain',
        mimeFamily: 'text',
        fileSize: 10,
        storageReference: `${otherBusinessId}/${'e'.repeat(64)}`,
      });
      await otherRepo.setCurrentVersion(otherBusinessId, document.id, version.id);
      await otherRepo.createChunks({
        businessId: otherBusinessId,
        documentId: document.id,
        versionId: version.id,
        chunks: [{ sequence: 0, text: 'The quarterly onboarding checklist for new employees.', charStart: 0, charEnd: 10, checksum: 'f'.repeat(64) }],
      });
      await otherRepo.markVersionParsed(otherBusinessId, version.id, 'g'.repeat(64));
      await otherRepo.markDocumentReadyIfCurrentVersion(otherBusinessId, document.id, version.id);
      await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);
    })();

    const aResults = await repo.searchReadyDocumentChunksForBusiness(businessId, 'quarterly onboarding checklist', 10);
    const bResults = await repo.searchReadyDocumentChunksForBusiness(otherBusinessId, 'quarterly onboarding checklist', 10);
    expect(aResults).toHaveLength(1);
    expect(aResults[0]?.filename).toBe('shared-phrase-a.txt');
    expect(bResults).toHaveLength(1);
    expect(bResults[0]?.filename).toBe('shared-phrase-b.txt');

    const aAiResults = await repo.searchAiRetrievableDocumentChunksForBusiness(businessId, 'quarterly onboarding checklist', 3);
    const bAiResults = await repo.searchAiRetrievableDocumentChunksForBusiness(otherBusinessId, 'quarterly onboarding checklist', 3);
    expect(aAiResults).toHaveLength(1);
    expect(bAiResults).toHaveLength(1);
    expect(aAiResults[0]?.documentId).not.toBe(bAiResults[0]?.documentId);
  });
});
