import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import {
  createKnowledgeBaseDocument,
  listKnowledgeBaseDocuments,
  updateKnowledgeBaseDocument,
  deleteKnowledgeBaseDocument,
  isKnowledgeBaseDocumentNotFoundError,
  isInvalidKnowledgeBaseDocumentError,
} from '../src/services/knowledgeBaseService.js';
import { searchKnowledgeBase } from '../src/services/knowledgeBaseSearchService.js';
import { createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';
import { isEntitlementDeniedError } from '../src/services/workspaceService.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('knowledgeBaseService + knowledgeBaseSearchService (real Postgres full-text search, no fabricated results)', () => {
  let businessId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
  });

  it('creates, lists, updates, and deletes a real document', async () => {
    const created = await createKnowledgeBaseDocument(businessId, ownerId, 'Refund Policy', 'Refunds are issued within 14 days of purchase.');
    expect(created.title).toBe('Refund Policy');

    const listed = await listKnowledgeBaseDocuments(businessId);
    expect(listed.map((d) => d.id)).toContain(created.id);

    const updated = await updateKnowledgeBaseDocument(businessId, created.id, 'Refund Policy (updated)', 'Refunds are issued within 30 days of purchase.');
    expect(updated.title).toBe('Refund Policy (updated)');
    expect(updated.content).toContain('30 days');

    await deleteKnowledgeBaseDocument(businessId, created.id);
    expect((await listKnowledgeBaseDocuments(businessId)).map((d) => d.id)).not.toContain(created.id);
  });

  it('rejects an empty title or content, never storing a blank document', async () => {
    await expect(createKnowledgeBaseDocument(businessId, ownerId, '  ', 'real content')).rejects.toThrow();
    await expect(createKnowledgeBaseDocument(businessId, ownerId, 'real title', '  ')).rejects.toThrow();
    try {
      await createKnowledgeBaseDocument(businessId, ownerId, '', 'x');
    } catch (error) {
      expect(isInvalidKnowledgeBaseDocumentError(error)).toBe(true);
    }
  });

  it('refuses to update or delete a document belonging to a different business (real tenant isolation)', async () => {
    const doc = await createKnowledgeBaseDocument(businessId, ownerId, 'Only ours', 'Secret internal content');
    const otherBusinessId = await createTestBusiness('Other Business');

    await expect(updateKnowledgeBaseDocument(otherBusinessId, doc.id, 'Hijacked', 'Hijacked content')).rejects.toThrow();
    try {
      await updateKnowledgeBaseDocument(otherBusinessId, doc.id, 'Hijacked', 'Hijacked content');
    } catch (error) {
      expect(isKnowledgeBaseDocumentNotFoundError(error)).toBe(true);
    }

    await expect(deleteKnowledgeBaseDocument(otherBusinessId, doc.id)).rejects.toThrow();

    // Untouched - still there, still original content.
    const stillOurs = await listKnowledgeBaseDocuments(businessId);
    expect(stillOurs.find((d) => d.id === doc.id)?.title).toBe('Only ours');
  });

  it('enforces the real per-plan max_knowledge_base_documents entitlement - a new business defaults to the Starter plan (limit 10)', async () => {
    for (let i = 0; i < 10; i += 1) {
      await createKnowledgeBaseDocument(businessId, ownerId, `Doc ${i}`, `Content for document number ${i}`);
    }
    await expect(createKnowledgeBaseDocument(businessId, ownerId, 'Doc 11', 'One too many')).rejects.toThrow();
    try {
      await createKnowledgeBaseDocument(businessId, ownerId, 'Doc 11', 'One too many');
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) expect(error.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
    }
  });

  it('searchKnowledgeBase finds a real, relevant document via Postgres full-text search - never a fabricated match', async () => {
    await createKnowledgeBaseDocument(businessId, ownerId, 'Shipping Times', 'Standard shipping takes 5 to 7 business days within the country.');
    await createKnowledgeBaseDocument(businessId, ownerId, 'Return Policy', 'Items can be returned within 30 days for a full refund.');

    const result = await searchKnowledgeBase(businessId, 'how long does shipping take');
    expect(result.available).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.title).toBe('Shipping Times');
  });

  it('an honest empty result (search worked, nothing matched) is distinct from unavailability', async () => {
    await createKnowledgeBaseDocument(businessId, ownerId, 'Shipping Times', 'Standard shipping takes 5 to 7 business days.');

    const result = await searchKnowledgeBase(businessId, 'completely unrelated aardvark taxonomy question');
    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('never returns a document from a different business (real tenant isolation in search)', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await createTestSubscription(otherBusinessId);
    await createKnowledgeBaseDocument(otherBusinessId, ownerId, 'Shipping Times', 'Standard shipping takes 5 to 7 business days.');

    const result = await searchKnowledgeBase(businessId, 'shipping times');
    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
  });
});
