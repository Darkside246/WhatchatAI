import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { queueConnection } from '../connection.js';
import { DOCUMENT_PARSE_QUEUE, type DocumentParseJobData } from '../queues/documentParseQueue.js';
import { pool } from '../../db/pool.js';
import { BusinessDocumentRepository } from '../../repositories/businessDocumentRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { retrieveMedia } from '../../media/localEncryptedMediaStorage.js';
import { parseDocument, type DocumentParseFailureReason } from '../../services/documents/documentParsers.js';
import { chunkText } from '../../services/documents/documentChunker.js';
import type { DocumentMimeFamily } from '../../domain/documents/documentMime.js';

const documentRepository = new BusinessDocumentRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

/**
 * D2: strict parser-isolation phase. This worker's only job is
 * ingestion -> extraction -> normalization -> chunking -> full-text
 * indexing. It never touches ai_retrievable/ai_sendable/customer_visible/
 * human_only - those remain exactly what D1 set them to (human-set only,
 * default false). Reaching status='ready' here means "chunked and
 * indexed," never "available to the AI" - that is a structurally
 * separate gate, enforced by a later phase's own capability check, not
 * by anything in this file.
 *
 * Re-scopes by businessId on every read, matching the Phase 0.1
 * principle applied from day one: a job whose businessId/documentId
 * pairing doesn't resolve to a real, still-current, non-deleted row is
 * simply not processed - never retried into forcing a result, never
 * assumed valid because it reached this queue at all.
 */
export async function processDocumentParseJob(data: DocumentParseJobData): Promise<void> {
  const { businessId, documentId, versionId } = data;

  const document = await documentRepository.findByIdForBusiness(documentId, businessId);
  if (!document) {
    console.warn(`[DocumentParseWorker] No such document ${documentId} for business ${businessId} - refusing to process`);
    return;
  }
  const version = await documentRepository.findVersionForBusiness(versionId, businessId);
  if (!version) {
    console.warn(`[DocumentParseWorker] No such version ${versionId} for business ${businessId} - refusing to process`);
    return;
  }
  // A version that changed (once a future phase allows re-uploading a new
  // version) or a document already past 'uploaded' (already processed,
  // or a retry of an already-terminal job) both stop here - idempotent
  // by construction, not by a separate dedup mechanism.
  if (document.currentVersionId !== versionId) {
    console.warn(`[DocumentParseWorker] Document ${documentId} no longer points at version ${versionId} - skipping stale job`);
    return;
  }
  if (document.status !== 'uploaded') {
    console.warn(`[DocumentParseWorker] Document ${documentId} is already "${document.status}" - skipping duplicate job`);
    return;
  }

  await documentRepository.markDocumentProcessing(businessId, documentId);
  await documentRepository.markVersionParsing(businessId, versionId);

  let buffer: Buffer;
  try {
    buffer = await retrieveMedia(businessId, version.storageReference);
  } catch {
    await failDocument(businessId, documentId, versionId, 'corrupted_or_unreadable');
    return;
  }

  const result = await parseDocument(version.mimeFamily as DocumentMimeFamily, buffer);
  if (result.status === 'failed') {
    await failDocument(businessId, documentId, versionId, result.reason);
    return;
  }

  const chunks = chunkText(result.text).map((chunk) => ({
    sequence: chunk.sequence,
    text: chunk.text,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    checksum: createHash('sha256').update(chunk.text).digest('hex'),
  }));

  if (chunks.length === 0) {
    await failDocument(businessId, documentId, versionId, 'empty_extracted_text');
    return;
  }

  const contentHash = createHash('sha256').update(result.text).digest('hex');
  await documentRepository.createChunks({ businessId, documentId, versionId, chunks });
  await documentRepository.markVersionParsed(businessId, versionId, contentHash);
  const becameReady = await documentRepository.markDocumentReadyIfCurrentVersion(businessId, documentId, versionId);

  // Structural/diagnostic only - chunk count and length, never the
  // extracted text itself.
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'business_document_parsed',
    rawMetadata: { documentId, versionId, chunkCount: chunks.length, extractedTextLength: result.text.length, becameReady },
  });
}

async function failDocument(
  businessId: string,
  documentId: string,
  versionId: string,
  reason: DocumentParseFailureReason,
): Promise<void> {
  // reason is always one of the fixed, sanitized categories from
  // documentParsers.ts - never a raw exception message, which can embed
  // fragments of the document's own bytes.
  await documentRepository.markVersionFailed(businessId, versionId, reason);
  await documentRepository.markDocumentFailedIfCurrentVersion(businessId, documentId, versionId);
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'business_document_parse_failed',
    severity: 'warning',
    reason,
    rawMetadata: { documentId, versionId, reason },
  });
}

async function processJob(job: Job<DocumentParseJobData>): Promise<void> {
  await processDocumentParseJob(job.data);
}

export const documentParseWorker = new Worker<DocumentParseJobData>(DOCUMENT_PARSE_QUEUE, processJob, {
  connection: queueConnection,
  concurrency: 2,
});

documentParseWorker.on('failed', (job, error) => {
  console.error(`[DocumentParseWorker] Job ${job?.id} failed:`, error.message);
});

documentParseWorker.on('error', (error) => {
  console.error('[DocumentParseWorker] Worker error:', error.message);
});

console.log('[DocumentParseWorker] Listening on queue "document_parse" (concurrency=2)');
