import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { uploadDocument } from '../src/services/documentService.js';
import { BusinessDocumentRepository } from '../src/repositories/businessDocumentRepository.js';
import { sweepStaleProcessingDocuments } from '../src/queue/workers/incomingMessagesWorker.js';
import { documentParseWorker } from '../src/queue/workers/documentParseWorker.js';
import { documentParseQueue } from '../src/queue/queues/documentParseQueue.js';
import { resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * Section 71 (Queue reliability): documentParseWorker's own "already past
 * uploaded, skip duplicate job" guard - deliberately correct for a genuine
 * BullMQ retry of a job that actually finished, see
 * documentParseWorker.test.ts's "safe no-op, never double-processed" case -
 * has a real side effect once a document is stuck at status='processing'
 * with no version ever reaching a terminal state: every subsequent retry
 * silently no-ops as a false success, so the job never reaches BullMQ's
 * 'failed' event and nothing ever reconciles it. This sweep is the backstop,
 * matching the same staleness-based pattern already used for stuck emails
 * (sweepStaleEmails) and stuck funnel instances (sweepStaleFunnelInstances).
 */
describe('sweepStaleProcessingDocuments (real Postgres)', () => {
  let businessId: string;
  let userId: string;
  let documentRepository: BusinessDocumentRepository;

  // This sweep exists precisely because the real documentParseWorker never
  // gets a chance to finish these documents - so its own real background
  // consumer must not be racing these direct repository calls, same reason
  // documentParseWorker.test.ts closes it up front.
  beforeAll(async () => {
    await documentParseWorker.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    await documentParseQueue.drain(true);
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    userId = owner.user.id;
    documentRepository = new BusinessDocumentRepository(pool);
  });

  async function makeStuckDocument(filename: string) {
    const { document, version } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename,
      mimeType: 'text/plain',
      fileBase64: Buffer.from('content that never finished parsing', 'utf8').toString('base64'),
    });
    // Replicates the real worker's first step (markDocumentProcessing) with
    // nothing after it ever running - the exact state left behind by an
    // exception thrown mid-parse, before any terminal status write.
    await documentRepository.markDocumentProcessing(businessId, document.id);
    await pool.query(`UPDATE business_documents SET updated_at = now() - interval '400 seconds' WHERE id = $1`, [document.id]);
    return { document, version };
  }

  it('reconciles a document stuck in processing past the staleness window to failed', async () => {
    const { document, version } = await makeStuckDocument('stuck.txt');

    await sweepStaleProcessingDocuments();

    const updated = await documentRepository.findByIdForBusiness(document.id, businessId);
    expect(updated?.status).toBe('failed');
    const updatedVersion = await documentRepository.findVersionForBusiness(version.id, businessId);
    expect(updatedVersion?.parserStatus).toBe('failed');
    expect(updatedVersion?.failureReason).toBeTruthy();
  });

  it('never touches a document still within the staleness window', async () => {
    const { document } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'recent.txt',
      mimeType: 'text/plain',
      fileBase64: Buffer.from('just started', 'utf8').toString('base64'),
    });
    await documentRepository.markDocumentProcessing(businessId, document.id);

    await sweepStaleProcessingDocuments();

    const updated = await documentRepository.findByIdForBusiness(document.id, businessId);
    expect(updated?.status).toBe('processing');
  });

  it('never touches a document that finished normally (status=ready or already uploaded)', async () => {
    const { document } = await uploadDocument({
      businessId,
      createdBy: userId,
      filename: 'untouched.txt',
      mimeType: 'text/plain',
      fileBase64: Buffer.from('never started processing', 'utf8').toString('base64'),
    });
    await pool.query(`UPDATE business_documents SET updated_at = now() - interval '400 seconds' WHERE id = $1`, [document.id]);

    await sweepStaleProcessingDocuments();

    const updated = await documentRepository.findByIdForBusiness(document.id, businessId);
    expect(updated?.status).toBe('uploaded');
  });

  it('running the sweep twice in a row is safe - the second run finds nothing left to do', async () => {
    await makeStuckDocument('stuck-twice.txt');

    await sweepStaleProcessingDocuments();
    await expect(sweepStaleProcessingDocuments()).resolves.not.toThrow();
  });

  it('a document deleted after getting stuck is never resurrected - the guarded update still checks current_version_id, and a deleted document is excluded from the sweep entirely', async () => {
    const { document } = await makeStuckDocument('deleted-while-stuck.txt');
    await documentRepository.softDeleteForBusiness(document.id, businessId);

    await expect(sweepStaleProcessingDocuments()).resolves.not.toThrow();

    const { rows } = await pool.query('SELECT status, deleted_at FROM business_documents WHERE id = $1', [document.id]);
    expect(rows[0]?.deleted_at).not.toBeNull();
  });
});
