import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { updateEmailSettings } from '../src/services/emailService.js';
import { EmailMessageRepository } from '../src/repositories/emailMessageRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

// Spies on the one call that would prove a real send happened - the worker
// must never reach it for a forged/mismatched job.
const sendEmailMock = vi.fn();
vi.mock('../src/services/emailProviderService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/emailProviderService.js')>();
  return { ...actual, sendEmail: (...args: unknown[]) => sendEmailMock(...args) };
});

const { emailSendQueue, enqueueEmailSend } = await import('../src/queue/queues/emailSendQueue.js');
await import('../src/queue/workers/emailSendWorker.js'); // registers the real BullMQ worker as a side effect

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/** Polls the real queue - the forged job either completes (email not found, logged, returned) or it doesn't; there is nothing else to await. */
async function waitForJobToDrain(emailMessageId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const jobs = await emailSendQueue.getJobs(['waiting', 'active', 'delayed']);
    if (!jobs.some((job) => job.data.emailMessageId === emailMessageId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the forged job to finish processing');
}

/**
 * E1 regression (Phase 0.1): the worker's job payload always carries a
 * businessId, but processJob() used to ignore it and re-fetch the email by
 * a bare, unscoped id. This proves the fix: a job whose businessId does not
 * match the email's real owner must be treated as "no such email," not as
 * a green light to read, mutate, or send it.
 */
describe('emailSendWorker (real BullMQ worker, real Postgres) - business-scoped job processing', () => {
  const originalResendKey = process.env.RESEND_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    await emailSendQueue.drain(true);
    sendEmailMock.mockReset();
    if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResendKey;
  });

  it('refuses to retrieve, send, mutate, or expose a real approved email when the job\'s businessId belongs to a different business', async () => {
    // Business B owns a real, genuinely approved (sendable) email.
    const ownerB = await register(
      { email: 'ownerb@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner B' },
      device,
    );
    const businessB = ownerB.business.id;
    const emails = new EmailMessageRepository(pool);
    const draft = await emails.createDraft({
      businessId: businessB,
      createdBy: ownerB.user.id,
      kind: 'general_update',
      toEmail: 'realcustomer@example.com',
      toName: 'Real Customer',
      subject: 'Business B private subject',
      bodyText: 'Business B private body - must never leave this tenant.',
    });
    const approved = await emails.approve(businessB, draft.id, ownerB.user.id);
    expect(approved?.status).toBe('approved');

    // Business A - a real, separate tenant with no relationship to that email.
    const businessA = await createTestBusiness('Business A');

    // A forged/mismatched job: a real email id belonging to Business B,
    // paired with Business A's businessId. Whatever produced this pairing
    // (a bug elsewhere, a compromised queue entry) is exactly what the
    // worker itself must refuse to trust.
    await enqueueEmailSend({ emailMessageId: draft.id, businessId: businessA });
    await waitForJobToDrain(draft.id);

    // Never sent - the provider must never have been invoked with Business B's content.
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Never mutated - still exactly the state it was in before the forged job ran.
    const untouched = await emails.findByIdForBusiness(businessB, draft.id);
    expect(untouched?.status).toBe('approved');
    expect(untouched?.approvedBy).toBe(ownerB.user.id);
    expect(untouched?.sentAt).toBeNull();
    expect(untouched?.lastError).toBeNull();
    expect(untouched?.subject).toBe('Business B private subject');
  });

  it('still sends normally when the job\'s businessId genuinely matches the email\'s owner (no regression)', async () => {
    const owner = await register(
      { email: 'owner-normal@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    const businessId = owner.business.id;
    const emails = new EmailMessageRepository(pool);
    const draft = await emails.createDraft({
      businessId,
      createdBy: owner.user.id,
      kind: 'general_update',
      toEmail: 'realcustomer@example.com',
      toName: 'Real Customer',
      subject: 'A real, correctly-owned send',
      bodyText: 'This one should go through.',
    });
    await emails.approve(businessId, draft.id, owner.user.id);

    sendEmailMock.mockResolvedValue({ status: 'sent', provider: 'resend', providerMessageId: 'msg-123' });

    process.env.RESEND_API_KEY = 'test-key-never-used-for-a-real-call';
    await updateEmailSettings(businessId, owner.user.id, {
      provider: 'resend',
      fromEmail: 'hello@example.com',
      fromName: 'Example Co',
      resendApiKey: 'test-workspace-key',
    });

    await enqueueEmailSend({ emailMessageId: draft.id, businessId });
    await waitForJobToDrain(draft.id);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const updated = await emails.findByIdForBusiness(businessId, draft.id);
    expect(updated?.status).toBe('sent');
  });
});
