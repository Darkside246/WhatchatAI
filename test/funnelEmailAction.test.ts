import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { EmailMessageRepository } from '../src/repositories/emailMessageRepository.js';
import { IntegrationSettingsRepository } from '../src/repositories/integrationSettingsRepository.js';
import { sendFunnelEmail } from '../src/services/emailService.js';
import { emailSendQueue } from '../src/queue/queues/emailSendQueue.js';
import { createTestAccount, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * A funnel may send email without someone clicking approve, but only under
 * conditions that keep the approval boundary meaningful: static
 * operator-authored text, a real recipient address, and an attributable
 * approver. These pin all three.
 */
describe('funnel SEND_EMAIL action', () => {
  let businessId: string;
  let ownerId: string;
  let crmContactId: string;
  let chatId: string;
  let emails: EmailMessageRepository;

  const originalKey = process.env.RESEND_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    await emailSendQueue.drain(true);
    delete process.env.RESEND_API_KEY;

    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
    ownerId = owner.user.id;
    const accountId = await createTestAccount(businessId);

    const chat = await pool.query<{ id: string }>(
      `INSERT INTO whatsapp_chats (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type)
       VALUES ($1, $2, '15550002222@s.whatsapp.net', 'individual', 'individual') RETURNING id`,
      [businessId, accountId],
    );
    chatId = chat.rows[0]!.id;

    // A CRM profile is created from a real WhatsApp contact identity, which
    // is the only path the repository offers.
    const waContact = await pool.query<{ id: string }>(
      `INSERT INTO whatsapp_contacts (business_id, whatsapp_account_id, whatsapp_jid, jid_kind)
       VALUES ($1, $2, '15550002222@s.whatsapp.net', 'individual') RETURNING id`,
      [businessId, accountId],
    );
    const contacts = new CrmContactRepository(pool);
    const contact = await contacts.upsertForWhatsAppContact({
      businessId,
      whatsappContactId: waContact.rows[0]!.id,
      source: 'test',
    });
    crmContactId = contact.id;
    emails = new EmailMessageRepository(pool);

    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  async function configureSending() {
    process.env.RESEND_API_KEY = 'test-key-never-used-for-a-real-call';
    await new IntegrationSettingsRepository(pool).upsertEmail({
      businessId,
      provider: 'resend',
      fromEmail: 'hello@example.com',
      fromName: null,
      replyToEmail: null,
      resendApiKey: 'workspace-key',
    });
  }

  it('sends with the funnel author recorded as the approver, so every send is attributable', async () => {
    await configureSending();

    const email = await sendFunnelEmail({
      businessId,
      authorisedBy: ownerId,
      funnelId: '00000000-0000-4000-8000-000000000abc',
      crmContactId,
      chatId,
      toEmail: 'customer@example.com',
      subject: 'Your appointment',
      bodyText: 'See you Thursday.',
    });

    expect(email.status).toBe('approved');
    // Not a null or synthetic approver - a real user id.
    expect(email.approvedBy).toBe(ownerId);
    expect(email.approvedAt).not.toBeNull();
    // ...and it is genuinely queued.
    const jobs = await emailSendQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.emailMessageId === email.id)).toBe(true);
  });

  it('leaves the email as a draft when sending is not configured, instead of losing it', async () => {
    delete process.env.RESEND_API_KEY;

    const email = await sendFunnelEmail({
      businessId,
      authorisedBy: ownerId,
      funnelId: '00000000-0000-4000-8000-000000000abc',
      crmContactId,
      chatId,
      toEmail: 'customer@example.com',
      subject: 'Your appointment',
      bodyText: 'See you Thursday.',
    });

    expect(email.status).toBe('draft');
    expect(email.approvedBy).toBeNull();

    // It is still there for a human to find and send later.
    const stored = await emails.findById(email.id);
    expect(stored?.status).toBe('draft');

    const jobs = await emailSendQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.emailMessageId === email.id)).toBe(false);
  });

  it('rejects an invalid recipient rather than queueing a doomed send', async () => {
    await configureSending();

    await expect(
      sendFunnelEmail({
        businessId,
        authorisedBy: ownerId,
        funnelId: '00000000-0000-4000-8000-000000000abc',
        crmContactId,
        chatId,
        toEmail: 'not-an-address',
        subject: 'Hello',
        bodyText: 'Hello',
      }),
    ).rejects.toThrow(/not a valid email address/i);
  });

  it('stores a contact email only when someone enters one - it is never derived', async () => {
    const contacts = new CrmContactRepository(pool);

    const before = await contacts.findByIdForBusiness(businessId, crmContactId);
    expect(before?.email).toBeNull();

    await contacts.update(businessId, crmContactId, {
      stage: null,
      leadStatus: null,
      notes: null,
      tags: [],
      email: 'entered@example.com',
    });

    const after = await contacts.findByIdForBusiness(businessId, crmContactId);
    expect(after?.email).toBe('entered@example.com');
  });

  it('leaves a stored contact email alone when an update omits it', async () => {
    const contacts = new CrmContactRepository(pool);
    await contacts.update(businessId, crmContactId, { stage: null, leadStatus: null, notes: null, tags: [], email: 'keep@example.com' });

    // An edit that only touches the notes must not wipe the address.
    await contacts.update(businessId, crmContactId, { stage: null, leadStatus: null, notes: 'edited', tags: [] });

    const after = await contacts.findByIdForBusiness(businessId, crmContactId);
    expect(after?.email).toBe('keep@example.com');
    expect(after?.notes).toBe('edited');
  });
});
