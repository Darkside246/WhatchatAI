import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { BusinessDocumentRepository } from '../src/repositories/businessDocumentRepository.js';
import { gatherAiHandoffContext } from '../src/services/aiContextGathererService.js';
import { uploadDocument } from '../src/services/documentService.js';
import { processDocumentParseJob, documentParseWorker } from '../src/queue/workers/documentParseWorker.js';
import { MAX_QUERY_LENGTH } from '../src/services/aiDocumentRetrievalService.js';
import { createTestAccount, createTestBusiness, createTestSubscription, createTestUser, resetDatabase } from './helpers.js';

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('gatherAiHandoffContext (real Promise.all over Postgres, including real KB full-text search)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('gathers CRM contact, conversation history, and a real (empty) knowledge-base search result concurrently', async () => {
    const contactRepo = new WhatsAppContactRepository(pool);
    const chatRepo = new WhatsAppChatRepository(pool);
    const messageRepo = new WhatsAppMessageRepository(pool);
    const crmRepo = new CrmContactRepository(pool);

    const contact = await contactRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      pushName: 'Context Test Contact',
    });

    const crmContact = await crmRepo.upsertForWhatsAppContact({
      businessId,
      whatsappContactId: contact.id,
      source: 'whatsapp',
      stage: 'new',
      leadStatus: 'open',
    });

    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      contactId: contact.id,
    });

    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId: 'CTX-MSG-1',
      remoteJid: '15550009999@s.whatsapp.net',
      senderJid: '15550009999@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'earlier message in the conversation',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });

    const context = await gatherAiHandoffContext({
      businessId,
      chatId: chat.id,
      contactId: contact.id,
      queryText: 'What is my order status?',
    });

    expect(context.crmContact?.id).toBe(crmContact.id);
    expect(context.conversationHistory).toHaveLength(1);
    expect(context.conversationHistory[0]?.textContent).toBe('earlier message in the conversation');

    // A real knowledge base search now runs (Phase 6) - with no documents
    // created for this business, an honest "search worked, nothing to find"
    // result is expected: available, zero results, never fabricated matches.
    expect(context.knowledgeBase.available).toBe(true);
    expect(context.knowledgeBase.results).toEqual([]);
  });

  it('returns a null CRM contact for a group chat with no contactId, without failing the other lookups', async () => {
    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '120363000000000000@g.us',
      jidKind: 'group',
      chatType: 'group',
    });

    const context = await gatherAiHandoffContext({
      businessId,
      chatId: chat.id,
      contactId: null,
      queryText: 'group question',
    });

    expect(context.crmContact).toBeNull();
    expect(context.conversationHistory).toEqual([]);
  });
});

/**
 * Phase D4-B: wiring retrieveAiDocumentContext (D3-C) into
 * gatherAiHandoffContext's existing Promise.all, exactly the same shape
 * as the searchKnowledgeBase branch already proven above. Every claim
 * here is exercised through the real gatherAiHandoffContext entry point -
 * never the document-retrieval service called directly - so it proves
 * the wiring itself, not just the D3-C service in isolation.
 */
describe('gatherAiHandoffContext documentContext (Phase D4-B - real Postgres, real upload/parse/retrieve round trip)', () => {
  let businessId: string;
  let accountId: string;
  let userId: string;

  beforeAll(async () => {
    // Same D2-established fix reused throughout D3/D4: importing
    // documentParseWorker.ts starts a real BullMQ consumer as a module
    // side effect, which would otherwise race this suite's direct
    // processDocumentParseJob() calls.
    await documentParseWorker.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    await createTestSubscription(businessId);
    accountId = await createTestAccount(businessId);
    userId = await createTestUser(businessId);
  });

  async function uploadAndParse(businessIdForUpload: string, filename: string, content: string) {
    const { document, version } = await uploadDocument({
      businessId: businessIdForUpload,
      createdBy: userId,
      filename,
      mimeType: 'text/plain',
      fileBase64: toBase64(content),
    });
    await processDocumentParseJob({ businessId: businessIdForUpload, documentId: document.id, versionId: version.id });
    return { document, version };
  }

  async function context(queryText: string, overrides: { chatId?: string } = {}) {
    return gatherAiHandoffContext({
      businessId,
      // A syntactically valid but non-existent UUID - listByChat's own
      // scoped query simply returns no rows for it, exactly like a real
      // chat with no history yet. These tests are about documentContext,
      // not conversation history, so no real chat/message fixtures are needed.
      chatId: overrides.chatId ?? '00000000-0000-0000-0000-000000000001',
      contactId: null,
      queryText,
    });
  }

  it('1. a same-business ai_retrievable document enters documentContext', async () => {
    const { document } = await uploadAndParse(businessId, 'refund-policy.txt', 'Refunds are honored within falcon-umber-6 days of purchase.');
    await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);

    const result = await context('falcon-umber-6');
    expect(result.documentContext.available).toBe(true);
    expect(result.documentContext.results).toHaveLength(1);
    expect(result.documentContext.results[0]?.documentId).toBe(document.id);
    expect(result.documentContext.results[0]?.documentTitle).toBe('refund-policy.txt');
  });

  it('2. a document from another business never enters documentContext', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await createTestSubscription(otherBusinessId);
    const otherUserId = await createTestUser(otherBusinessId);
    const { document, version } = await uploadDocument({
      businessId: otherBusinessId,
      createdBy: otherUserId,
      filename: 'other-business.txt',
      mimeType: 'text/plain',
      fileBase64: toBase64('A distinctive marker: raven-cobalt-15.'),
    });
    await processDocumentParseJob({ businessId: otherBusinessId, documentId: document.id, versionId: version.id });
    await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);

    const result = await context('raven-cobalt-15');
    expect(result.documentContext.available).toBe(true);
    expect(result.documentContext.results).toEqual([]);
  });

  it('3. a soft-deleted document never enters documentContext', async () => {
    const { document } = await uploadAndParse(businessId, 'to-delete.txt', 'Confidential content marker: heron-slate-8.');
    await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);
    await pool.query('UPDATE business_documents SET deleted_at = now() WHERE id = $1', [document.id]);

    const result = await context('heron-slate-8');
    expect(result.documentContext.available).toBe(true);
    expect(result.documentContext.results).toEqual([]);
  });

  it('4. a non-current document version never enters documentContext', async () => {
    const { document, version: firstVersion } = await uploadAndParse(businessId, 'v1.txt', 'Obsolete version marker: willow-trace-7.');
    await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);

    // A second real version supersedes the first on the SAME document (via
    // the repository directly, matching businessDocumentSearchRepository.
    // test.ts's own obsolete-version test) - the document's current
    // pointer moves on, but the first version's chunk rows remain
    // physically present (no CASCADE), same as D3-A's audit finding.
    const repo = new BusinessDocumentRepository(pool);
    const secondVersion = await repo.createVersion({
      businessId,
      documentId: document.id,
      versionNumber: 2,
      checksum: createHash('sha256').update('current-content-2').digest('hex'),
      mimeType: 'text/plain',
      mimeFamily: 'text',
      fileSize: 20,
      storageReference: `${businessId}/${createHash('sha256').update('current-content-2').digest('hex')}`,
    });
    await repo.setCurrentVersion(businessId, document.id, secondVersion.id);
    await repo.createChunks({
      businessId,
      documentId: document.id,
      versionId: secondVersion.id,
      chunks: [{ sequence: 0, text: 'Current version content, unrelated to the obsolete marker.', charStart: 0, charEnd: 20, checksum: createHash('sha256').update('second-chunk').digest('hex') }],
    });
    await repo.markVersionParsed(businessId, secondVersion.id, createHash('sha256').update('current-content-2').digest('hex'));
    await repo.markDocumentReadyIfCurrentVersion(businessId, document.id, secondVersion.id);

    const result = await context('willow-trace-7');
    expect(result.documentContext.results).toEqual([]);
    const stillPresent = await pool.query('SELECT count(*)::int AS count FROM business_document_chunks WHERE version_id = $1', [firstVersion.id]);
    expect(stillPresent.rows[0].count).toBeGreaterThan(0);
  });

  it('5. an ai_retrievable=false document (the default) never enters documentContext, even though it is ready', async () => {
    await uploadAndParse(businessId, 'internal.txt', 'Internal-only marker, never for the AI: otter-lumen-9.');

    const result = await context('otter-lumen-9');
    expect(result.documentContext.available).toBe(true);
    expect(result.documentContext.results).toEqual([]);
  });

  it('7. document retrieval failure does not break the rest of context assembly', async () => {
    const { document } = await uploadAndParse(businessId, 'unrelated.txt', 'Unrelated content.');
    await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);

    // An oversized query fails only aiDocumentRetrievalService's own
    // MAX_QUERY_LENGTH guard - it never reaches the database, and it does
    // not affect any other Promise.all branch (knowledgeBase has no such
    // length guard and still runs normally).
    const oversizedQuery = 'a'.repeat(MAX_QUERY_LENGTH + 1);
    const result = await context(oversizedQuery);

    expect(result.documentContext.available).toBe(false);
    expect(result.documentContext.results).toEqual([]);
    expect(result.documentContext.reason).not.toBeNull();
    // The rest of gatherAiHandoffContext's Promise.all still completed -
    // proving one branch's failure never fails the whole context object.
    expect(result.knowledgeBase.available).toBe(true);
    expect(result.businessTimezone).toBeTruthy();
  });

  it('8. an honest empty document result changes nothing else about the gathered context', async () => {
    const result = await context('completely unrelated aardvark taxonomy question');
    expect(result.documentContext).toEqual({ available: true, results: [], reason: null });
    expect(result.crmContact).toBeNull();
  });

  it('11. AI context via the wiring is bounded to the documented D3 limits (max 3 chunks, 500 chars each)', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { document } = await uploadAndParse(businessId, `doc-${i}.txt`, `${'x'.repeat(600)} plover-sienna-marker document ${i}.`);
      await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);
    }

    const result = await context('plover-sienna-marker');
    expect(result.documentContext.results.length).toBeLessThanOrEqual(3);
    for (const chunk of result.documentContext.results) {
      expect(chunk.text.length).toBeLessThanOrEqual(500);
    }
  });

  it('12. businessId is a fixed input to gatherAiHandoffContext, never parsed out of queryText - a UUID-shaped query for another business never redirects the search', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await createTestSubscription(otherBusinessId);
    const otherUserId = await createTestUser(otherBusinessId);
    const { document, version } = await uploadDocument({
      businessId: otherBusinessId,
      createdBy: otherUserId,
      filename: 'other-business-secret.txt',
      mimeType: 'text/plain',
      fileBase64: toBase64('A uniquely identifiable phrase: sable-quartz-88.'),
    });
    await processDocumentParseJob({ businessId: otherBusinessId, documentId: document.id, versionId: version.id });
    await pool.query('UPDATE business_documents SET ai_retrievable = true WHERE id = $1', [document.id]);

    // The query text itself contains the other business's real id - if
    // businessId were ever derived from message content instead of the
    // fixed parameter, this would leak. It must not.
    const result = await context(`sable-quartz-88 (business ${otherBusinessId})`);
    expect(result.documentContext.results).toEqual([]);
  });
});
