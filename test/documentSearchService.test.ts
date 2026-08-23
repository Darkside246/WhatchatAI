import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../src/services/authService.js';
import { uploadDocument } from '../src/services/documentService.js';
import { processDocumentParseJob } from '../src/queue/workers/documentParseWorker.js';
import { documentParseWorker } from '../src/queue/workers/documentParseWorker.js';
import { searchBusinessDocuments, MAX_QUERY_LENGTH } from '../src/services/documentSearchService.js';
import { createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Human document search (D3-C). Never requires ai_retrievable - proven
 * separately at the repository layer (businessDocumentSearchRepository.
 * test.ts) and again here end-to-end via a real upload -> real parse ->
 * real search round trip.
 */
describe('documentSearchService (Phase B D3-C - real Postgres, real parsing, real search)', () => {
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    // Prevent the real background document-parse worker (started as a
    // module side effect) from racing this suite's explicit, direct
    // processDocumentParseJob() calls - the exact bug found and fixed in
    // D2's own test suite.
    await documentParseWorker.close();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    userId = owner.user.id;
  });

  it('finds a real, relevant, ready document end-to-end (upload -> parse -> search)', async () => {
    const { document, version } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'shipping-policy.txt',
      mimeType: 'text/plain',
      fileBase64: toBase64('Standard shipping takes 5 to 7 business days within the country.'),
    });
    await processDocumentParseJob({ businessId, documentId: document.id, versionId: version.id });

    const result = await searchBusinessDocuments(businessId, 'how long does shipping take');
    expect(result.available).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.filename).toBe('shipping-policy.txt');
  });

  it('19. an honest empty result (search worked, nothing matched) is distinct from unavailability', async () => {
    const { document, version } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'shipping-policy.txt',
      mimeType: 'text/plain',
      fileBase64: toBase64('Standard shipping takes 5 to 7 business days.'),
    });
    await processDocumentParseJob({ businessId, documentId: document.id, versionId: version.id });

    const result = await searchBusinessDocuments(businessId, 'completely unrelated aardvark taxonomy question');
    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('an empty query short-circuits to an honest empty result without touching the database', async () => {
    const result = await searchBusinessDocuments(businessId, '   ');
    expect(result).toEqual({ available: true, results: [], reason: null });
  });

  it('17. a query exceeding the maximum length is rejected, not silently truncated and executed', async () => {
    const result = await searchBusinessDocuments(businessId, 'a'.repeat(MAX_QUERY_LENGTH + 1));
    expect(result.available).toBe(false);
    expect(result.reason).toContain(String(MAX_QUERY_LENGTH));
    expect(result.results).toEqual([]);
  });

  it('16. human search results are bounded to the documented maximum (10)', async () => {
    // Starter (this suite's default, via register()) caps at 10 documents
    // total - too low to prove a 10-result bound with 12 matching
    // documents. A fresh business on the Growth plan (50-document cap) is
    // needed so the upload loop itself isn't the thing limiting the count.
    const boundedBusinessId = await createTestBusiness('Bounded Search Business');
    await createTestSubscription(boundedBusinessId, 'growth');

    for (let i = 0; i < 12; i += 1) {
      const { document, version } = await uploadDocument({
        businessId: boundedBusinessId,
        createdBy: userId,
        filename: `doc-${i}.txt`,
        mimeType: 'text/plain',
        fileBase64: toBase64(`Shared marker phrase egret-cinder appears in document number ${i}.`),
      });
      await processDocumentParseJob({ businessId: boundedBusinessId, documentId: document.id, versionId: version.id });
    }

    const result = await searchBusinessDocuments(boundedBusinessId, 'egret-cinder');
    expect(result.available).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  it('20. a real search failure is reported as unavailable, distinct from a genuine empty result', async () => {
    // A malformed businessId is not a valid UUID - Postgres itself rejects
    // it as a real, non-mocked database error, exercising the same catch
    // path a genuine outage would.
    const result = await searchBusinessDocuments('not-a-valid-uuid', 'anything');
    expect(result.available).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.reason).not.toBeNull();
  });

  it('never leaks another business\'s document through search, end-to-end', async () => {
    const otherOwner = await createTestBusiness('Other Business');
    await createTestSubscription(otherOwner);

    const { document, version } = await uploadDocument({
      businessId: otherOwner,
      createdBy: userId, // fine for this fixture - not exercising membership rules here
      filename: 'other-business-secret.txt',
      mimeType: 'text/plain',
      fileBase64: toBase64('A uniquely identifiable phrase: sable-quartz-88.'),
    });
    await processDocumentParseJob({ businessId: otherOwner, documentId: document.id, versionId: version.id });

    const result = await searchBusinessDocuments(businessId, 'sable-quartz-88');
    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
  });
});
