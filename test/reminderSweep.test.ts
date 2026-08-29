import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ReminderRepository } from '../src/repositories/reminderRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppOutboundMessageRepository } from '../src/repositories/whatsappOutboundMessageRepository.js';
import { sweepDueReminders } from '../src/queue/workers/incomingMessagesWorker.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const NOTIFY_JID = '12461234567@s.whatsapp.net';

describe('sweepDueReminders (real Postgres, no fabricated delivery)', () => {
  let businessId: string;
  let accountId: string;
  let reminders: ReminderRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    reminders = new ReminderRepository(pool);
  });

  async function createNotifyChat(): Promise<string> {
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: NOTIFY_JID,
      jidKind: 'individual',
      chatType: 'individual',
    });
    return chat.id;
  }

  it('delivers a due reminder as a real outbound WhatsApp message', async () => {
    await createNotifyChat();
    const reminder = await reminders.create({
      businessId,
      whatsappAccountId: accountId,
      notifyJid: NOTIFY_JID,
      message: 'Reorder pool chemicals',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      createdByJid: NOTIFY_JID,
    });

    await sweepDueReminders();

    const outboundRepo = new WhatsAppOutboundMessageRepository(pool);
    const sent = await outboundRepo.findByIdempotencyKey(businessId, accountId, `reminder:${reminder.id}`);
    expect(sent).not.toBeNull();
    expect(sent?.textContent).toContain('Reorder pool chemicals');

    const updated = await reminders.findByIdForBusiness(reminder.id, businessId);
    expect(updated?.status).toBe('SENT');
    expect(updated?.sentAt).not.toBeNull();
  });

  it('never delivers a reminder that is not yet due', async () => {
    await createNotifyChat();
    const reminder = await reminders.create({
      businessId,
      whatsappAccountId: accountId,
      notifyJid: NOTIFY_JID,
      message: 'Future reminder',
      dueAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      createdByJid: NOTIFY_JID,
    });

    await sweepDueReminders();

    const updated = await reminders.findByIdForBusiness(reminder.id, businessId);
    expect(updated?.status).toBe('PENDING');
  });

  it('reconciles to FAILED, never a false SENT, when no chat exists for notify_jid', async () => {
    // Deliberately no createNotifyChat() call - the operator's own chat does not exist.
    const reminder = await reminders.create({
      businessId,
      whatsappAccountId: accountId,
      notifyJid: NOTIFY_JID,
      message: 'Orphaned reminder',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      createdByJid: NOTIFY_JID,
    });

    await sweepDueReminders();

    const updated = await reminders.findByIdForBusiness(reminder.id, businessId);
    expect(updated?.status).toBe('FAILED');
    expect(updated?.lastError).toContain('No chat found');
  });

  it('never delivers a cancelled reminder', async () => {
    await createNotifyChat();
    const reminder = await reminders.create({
      businessId,
      whatsappAccountId: accountId,
      notifyJid: NOTIFY_JID,
      message: 'Should not send',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      createdByJid: NOTIFY_JID,
    });
    const cancelled = await reminders.cancel(reminder.id, businessId);
    expect(cancelled).toBe(true);

    await sweepDueReminders();

    const outboundRepo = new WhatsAppOutboundMessageRepository(pool);
    const sent = await outboundRepo.findByIdempotencyKey(businessId, accountId, `reminder:${reminder.id}`);
    expect(sent).toBeNull();
  });

  it('cannot cancel a reminder already sent - it is a terminal, honest record', async () => {
    await createNotifyChat();
    const reminder = await reminders.create({
      businessId,
      whatsappAccountId: accountId,
      notifyJid: NOTIFY_JID,
      message: 'Already sent',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      createdByJid: NOTIFY_JID,
    });
    await sweepDueReminders();

    const cancelled = await reminders.cancel(reminder.id, businessId);
    expect(cancelled).toBe(false);
  });

  it('tenant isolation - listUpcoming for one business never returns another business\'s reminders', async () => {
    await createNotifyChat();
    await reminders.create({
      businessId,
      whatsappAccountId: accountId,
      notifyJid: NOTIFY_JID,
      message: 'Mine',
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      createdByJid: NOTIFY_JID,
    });

    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAccountId = await createTestAccount(otherBusinessId, '15550002222@s.whatsapp.net');
    await reminders.create({
      businessId: otherBusinessId,
      whatsappAccountId: otherAccountId,
      notifyJid: NOTIFY_JID,
      message: 'Not mine',
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      createdByJid: NOTIFY_JID,
    });

    const upcoming = await reminders.listUpcoming(businessId);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.message).toBe('Mine');
  });
});
