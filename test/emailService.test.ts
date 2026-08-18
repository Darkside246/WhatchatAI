import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { EmailMessageRepository } from '../src/repositories/emailMessageRepository.js';
import {
  createDraft,
  approveAndSend,
  updateDraft,
  cancelEmail,
  listEmails,
  getEmail,
  updateEmailSettings,
  getEmailCapabilities,
  draftWithAi,
  isEmailNotApprovableError,
  isInvalidEmailError,
  isEmailNotFoundError,
} from '../src/services/emailService.js';
import { emailSendQueue } from '../src/queue/queues/emailSendQueue.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * The property these tests exist to protect: an email cannot reach a real
 * customer without a real person approving it, and nothing is ever recorded
 * as sent that was not actually sent by a provider.
 */
describe('emailService (draft -> human approval -> send)', () => {
  let businessId: string;
  let ownerId: string;
  let emails: EmailMessageRepository;

  const originalKey = process.env.RESEND_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    await emailSendQueue.drain(true);
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
    ownerId = owner.user.id;
    emails = new EmailMessageRepository(pool);
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  async function configureSending() {
    process.env.RESEND_API_KEY = 'test-key-never-used-for-a-real-call';
    await updateEmailSettings(businessId, ownerId, {
      provider: 'resend',
      fromEmail: 'hello@example.com',
      fromName: 'Example Co',
      resendApiKey: 'test-workspace-key',
    });
  }

  const draftInput = {
    kind: 'general_update' as const,
    toEmail: 'customer@example.com',
    toName: 'Customer',
    subject: 'Your booking',
    bodyText: 'We have you booked for Thursday.',
  };

  it('creates a draft that is not approved and not queued for sending', async () => {
    const draft = await createDraft(businessId, ownerId, draftInput);

    expect(draft.status).toBe('draft');
    expect(draft.approvedBy).toBeNull();
    expect(draft.sentAt).toBeNull();

    const jobs = await emailSendQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.emailMessageId === draft.id)).toBe(false);
  });

  it('refuses to approve when no provider is configured, rather than approving something that cannot send', async () => {
    delete process.env.RESEND_API_KEY;
    await updateEmailSettings(businessId, ownerId, { provider: 'resend', fromEmail: 'hello@example.com' });
    const draft = await createDraft(businessId, ownerId, draftInput);

    await expect(approveAndSend(businessId, draft.id, ownerId)).rejects.toSatisfy(isInvalidEmailError);
    expect((await getEmail(businessId, draft.id)).status).toBe('draft');
  });

  it('refuses to approve when the workspace has no sender identity', async () => {
    process.env.RESEND_API_KEY = 'test-key-never-used-for-a-real-call';
    const draft = await createDraft(businessId, ownerId, draftInput);

    await expect(approveAndSend(businessId, draft.id, ownerId)).rejects.toSatisfy(isInvalidEmailError);
    expect((await getEmail(businessId, draft.id)).status).toBe('draft');
  });

  it('records a real approver and queues the send only after approval', async () => {
    await configureSending();
    const draft = await createDraft(businessId, ownerId, draftInput);

    const approved = await approveAndSend(businessId, draft.id, ownerId);

    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(ownerId);
    expect(approved.approvedAt).not.toBeNull();
    // Still not "sent" - only the worker, after a real provider call, may say that.
    expect(approved.sentAt).toBeNull();

    const jobs = await emailSendQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.emailMessageId === draft.id)).toBe(true);
  });

  it('refuses a second approval, so a double click cannot send twice', async () => {
    await configureSending();
    const draft = await createDraft(businessId, ownerId, draftInput);

    await approveAndSend(businessId, draft.id, ownerId);
    await expect(approveAndSend(businessId, draft.id, ownerId)).rejects.toSatisfy(isEmailNotApprovableError);
  });

  it('refuses to edit an email once approved - the approver must not have it changed underneath them', async () => {
    await configureSending();
    const draft = await createDraft(businessId, ownerId, draftInput);
    await approveAndSend(businessId, draft.id, ownerId);

    await expect(
      updateDraft(businessId, draft.id, { ...draftInput, bodyText: 'Completely different text' }),
    ).rejects.toSatisfy(isEmailNotApprovableError);
  });

  it('will not approve across workspaces', async () => {
    await configureSending();
    // register() provisions the single default business and then closes, so a
    // second workspace is created directly.
    const otherBusinessId = await createTestBusiness('Other Business');
    const draft = await createDraft(businessId, ownerId, draftInput);

    await expect(approveAndSend(otherBusinessId, draft.id, ownerId)).rejects.toSatisfy(isEmailNotFoundError);
    expect((await getEmail(businessId, draft.id)).status).toBe('draft');
  });

  it('rejects an invalid recipient address instead of queueing a doomed send', async () => {
    await expect(
      createDraft(businessId, ownerId, { ...draftInput, toEmail: 'not-an-address' }),
    ).rejects.toSatisfy(isInvalidEmailError);
  });

  it('cancels a draft and keeps it out of the send queue', async () => {
    const draft = await createDraft(businessId, ownerId, draftInput);
    const cancelled = await cancelEmail(businessId, draft.id, ownerId);

    expect(cancelled.status).toBe('cancelled');
    await expect(approveAndSend(businessId, draft.id, ownerId)).rejects.toSatisfy(isEmailNotApprovableError);
  });

  it('reports capabilities honestly when nothing is configured', async () => {
    delete process.env.RESEND_API_KEY;
    const capabilities = await getEmailCapabilities(businessId);

    expect(capabilities.providerConfigured).toBe(false);
    expect(capabilities.senderConfigured).toBe(false);
    expect(capabilities.reason).toBeTruthy();
  });

  it('reports AI drafting as unavailable when Gemini is not configured, rather than inventing a draft', async () => {
    const originalGemini = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const agentResult = await pool.query(
        `INSERT INTO ai_agents (business_id, name, status) VALUES ($1, 'Bookings', 'ACTIVE') RETURNING id`,
        [businessId],
      );
      const agentId = agentResult.rows[0].id as string;

      const result = await draftWithAi(businessId, ownerId, {
        agentId,
        kind: 'appointment',
        toEmail: 'customer@example.com',
        instruction: 'Confirm the Thursday booking',
      });

      expect(result.status).toBe('unavailable');
      // Nothing was persisted, so no empty draft is left lying around.
      expect(await listEmails(businessId)).toHaveLength(0);
    } finally {
      if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGemini;
    }
  });

  it('database itself refuses an approved row with no approver', async () => {
    const draft = await createDraft(businessId, ownerId, draftInput);

    // Belt-and-braces: even if the service were bypassed entirely, the CHECK
    // constraint stops an unapproved email from entering a sendable state.
    await expect(
      pool.query(`UPDATE email_messages SET status = 'approved' WHERE id = $1`, [draft.id]),
    ).rejects.toThrow();

    expect((await emails.findById(draft.id))?.status).toBe('draft');
  });
});
