import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppSyncJobRepository } from '../src/repositories/whatsappSyncJobRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { sweepStaleSyncJobs } from '../src/queue/workers/incomingMessagesWorker.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('sync job timeout reconciliation (real Postgres, documented 10-minute no-progress rule)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('reconciles a sync job abandoned mid-run (no progress in 10+ minutes) to "failed", never a fabricated completion', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const accountRepository = new WhatsAppAccountRepository(pool);

    const job = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.markRunning(job.id);
    await jobRepository.incrementCounts(job.id, { messagesProcessed: 1118, contactsProcessed: 178 });
    await accountRepository.markSyncStarted(accountId);

    // Simulate the abandonment: nothing has touched this row in 15 minutes.
    await pool.query(`UPDATE whatsapp_sync_jobs SET updated_at = now() - interval '15 minutes' WHERE id = $1`, [
      job.id,
    ]);

    await sweepStaleSyncJobs();

    const reconciled = await jobRepository.findById(job.id);
    expect(reconciled?.status).toBe('failed');
    expect(reconciled?.lastError).toContain('Abandoned mid-sync');
    // Real progress it actually made is preserved, not erased or inflated.
    expect(reconciled?.messagesProcessed).toBe(1118);

    const account = await accountRepository.findById(accountId);
    expect(account?.syncStatus).toBe('failed');
  });

  it('leaves a genuinely active sync job alone - real progress in the last 10 minutes is not a timeout', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const job = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.markRunning(job.id);
    await jobRepository.incrementCounts(job.id, { messagesProcessed: 50 });

    await sweepStaleSyncJobs();

    const stillRunning = await jobRepository.findById(job.id);
    expect(stillRunning?.status).toBe('running');
  });

  it('never touches a job that already reached a real terminal state', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const job = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.markRunning(job.id);
    await jobRepository.markCompleted(job.id);
    await pool.query(`UPDATE whatsapp_sync_jobs SET updated_at = now() - interval '15 minutes' WHERE id = $1`, [
      job.id,
    ]);

    await sweepStaleSyncJobs();

    const untouched = await jobRepository.findById(job.id);
    expect(untouched?.status).toBe('completed');
  });
});
