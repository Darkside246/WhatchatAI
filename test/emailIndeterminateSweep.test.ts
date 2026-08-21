import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { EmailMessageRepository } from '../src/repositories/emailMessageRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { sweepStaleEmails } from '../src/queue/workers/incomingMessagesWorker.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * A send stuck in 'sending' has no BullMQ retry waiting to resolve it
 * (markSending only ever re-claims an 'approved' row) - unlike the
 * WhatsApp outbound sweep, a stuck email is otherwise invisible forever.
 * The property under test: it is reconciled to 'indeterminate', never a
 * false 'failed' (we do not actually know whether the provider sent it),
 * and a real person is notified rather than the row silently vanishing.
 */
describe('sweepStaleEmails (real Postgres, no fabricated outcome)', () => {
  let businessId: string;
  let ownerId: string;
  let emails: EmailMessageRepository;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
    ownerId = owner.user.id;
    emails = new EmailMessageRepository(pool);
  });

  it('reconciles a send abandoned mid-dispatch to indeterminate, never to a false "sent" or "failed"', async () => {
    const draft = await emails.createDraft({
      businessId,
      createdBy: ownerId,
      kind: 'custom',
      toEmail: 'customer@example.com',
      subject: 'Order update',
      bodyText: 'Your order has shipped.',
    });
    await emails.approve(businessId, draft.id, ownerId);
    await emails.markSending(draft.id);
    await pool.query(`UPDATE email_messages SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [draft.id]);

    await sweepStaleEmails();

    const updated = await emails.findById(draft.id);
    expect(updated?.status).toBe('indeterminate');
    expect(updated?.lastError).toContain('unknown');
    expect(updated?.sentAt).toBeNull();
  });

  it('notifies the business so a human checks the real mailbox, rather than leaving it silently unresolved', async () => {
    const draft = await emails.createDraft({
      businessId,
      createdBy: ownerId,
      kind: 'custom',
      toEmail: 'customer@example.com',
      subject: 'Order update',
      bodyText: 'Your order has shipped.',
    });
    await emails.approve(businessId, draft.id, ownerId);
    await emails.markSending(draft.id);
    await pool.query(`UPDATE email_messages SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [draft.id]);

    await sweepStaleEmails();

    const notifications = new NotificationRepository(pool);
    const list = await notifications.listForUser(businessId, ownerId, 10);
    expect(list.some((n) => n.type === 'AUTOMATION_FAILURE' && n.body?.includes('customer@example.com'))).toBe(true);
  });

  it('leaves a recently-updated sending row alone - only genuinely abandoned sends are reconciled', async () => {
    const draft = await emails.createDraft({
      businessId,
      createdBy: ownerId,
      kind: 'custom',
      toEmail: 'customer@example.com',
      subject: 'Order update',
      bodyText: 'Your order has shipped.',
    });
    await emails.approve(businessId, draft.id, ownerId);
    await emails.markSending(draft.id);

    await sweepStaleEmails();

    const updated = await emails.findById(draft.id);
    expect(updated?.status).toBe('sending');
  });
});
