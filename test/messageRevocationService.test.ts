import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { ScheduledStatusRepository } from '../src/repositories/scheduledStatusRepository.js';
import {
  revokeMessage,
  revokeScheduledStatus,
  isNotRevocableError,
  isRevocationNotFoundError,
} from '../src/services/messageRevocationService.js';
import { messageRevocationsQueue } from '../src/queue/queues/messageRevocationsQueue.js';
import { register } from '../src/services/authService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

/**
 * These exercise the real rules WhatsApp itself imposes on
 * delete-for-everyone, against real Postgres rows and the real BullMQ queue.
 * Nothing here asserts that a message was "deleted" - the only thing the
 * system may ever claim is that a revoke instruction was requested and then
 * accepted, which is exactly what the states record.
 */
describe('messageRevocationService (real WhatsApp delete-for-everyone rules)', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  let messages: WhatsAppMessageRepository;
  let actingUserId: string;

  beforeEach(async () => {
    await resetDatabase();
    await messageRevocationsQueue.drain(true);
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
    actingUserId = owner.user.id;
    accountId = await createTestAccount(businessId);
    const chats = new WhatsAppChatRepository(pool);
    const chat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
    messages = new WhatsAppMessageRepository(pool);
  });

  async function insertMessage(overrides: { fromMe: boolean; whatsappMessageId: string; timestamp?: string }) {
    return messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: overrides.whatsappMessageId,
      remoteJid: '15550002222@s.whatsapp.net',
      senderJid: overrides.fromMe ? '15550001111@s.whatsapp.net' : '15550002222@s.whatsapp.net',
      direction: overrides.fromMe ? 'outbound' : 'inbound',
      messageType: 'text',
      textContent: 'Hello there',
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      fromMe: overrides.fromMe,
      isHistorical: false,
    });
  }

  it('queues a real revoke job for one of our own recent messages and records the request', async () => {
    const message = await insertMessage({ fromMe: true, whatsappMessageId: 'WA-OWN-1' });

    await revokeMessage(businessId, message.id, actingUserId);

    const reloaded = await messages.findById(message.id);
    expect(reloaded?.revokeStatus).toBe('requested');
    // Not 'revoke_sent' yet: nothing has actually reached WhatsApp at this point.
    expect(reloaded?.revokeSentAt).toBeNull();

    const jobs = await messageRevocationsQueue.getJobs(['waiting', 'delayed', 'active']);
    const jobForMessage = jobs.find((job) => job.data.kind === 'message' && job.data.messageId === message.id);
    expect(jobForMessage).toBeDefined();
  });

  it("refuses a message that is not ours - WhatsApp only lets the sender delete for everyone", async () => {
    const message = await insertMessage({ fromMe: false, whatsappMessageId: 'WA-THEIRS-1' });

    await expect(revokeMessage(businessId, message.id, actingUserId)).rejects.toSatisfy(isNotRevocableError);

    const reloaded = await messages.findById(message.id);
    expect(reloaded?.revokeStatus).toBe('none');
  });

  it('refuses a message older than the delete-for-everyone window instead of pretending', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const message = await insertMessage({ fromMe: true, whatsappMessageId: 'WA-OLD-1', timestamp: tenDaysAgo });

    await expect(revokeMessage(businessId, message.id, actingUserId)).rejects.toSatisfy(isNotRevocableError);

    const reloaded = await messages.findById(message.id);
    expect(reloaded?.revokeStatus).toBe('none');
  });

  it('refuses a second delete request for the same message, so a double click cannot double-send', async () => {
    const message = await insertMessage({ fromMe: true, whatsappMessageId: 'WA-OWN-2' });

    await revokeMessage(businessId, message.id, actingUserId);
    await expect(revokeMessage(businessId, message.id, actingUserId)).rejects.toSatisfy(isNotRevocableError);
  });

  it('refuses to touch another workspace’s message', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const message = await insertMessage({ fromMe: true, whatsappMessageId: 'WA-OWN-3' });

    await expect(revokeMessage(otherBusinessId, message.id, actingUserId)).rejects.toSatisfy(isRevocationNotFoundError);

    const reloaded = await messages.findById(message.id);
    expect(reloaded?.revokeStatus).toBe('none');
  });

  it('refuses to recall a published Status we hold no WhatsApp key for', async () => {
    const statuses = new ScheduledStatusRepository(pool);
    const created = await statuses.create({
      businessId,
      whatsappAccountId: accountId,
      createdBy: actingUserId,
      statusType: 'text',
      textContent: 'Open today until 6pm',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await statuses.updateStatus(created.id, 'PUBLISHED', { publishedAt: true });

    await expect(revokeScheduledStatus(businessId, created.id, actingUserId)).rejects.toSatisfy(isNotRevocableError);
  });

  it('queues a real recall for a published Status once we do hold its WhatsApp key', async () => {
    const statuses = new ScheduledStatusRepository(pool);
    const created = await statuses.create({
      businessId,
      whatsappAccountId: accountId,
      createdBy: actingUserId,
      statusType: 'text',
      textContent: 'Open today until 6pm',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await statuses.recordPublishedMessageId(created.id, 'WA-STATUS-1');
    await statuses.updateStatus(created.id, 'PUBLISHED', { publishedAt: true });

    await revokeScheduledStatus(businessId, created.id, actingUserId);

    const reloaded = await statuses.findById(created.id);
    expect(reloaded?.revokeStatus).toBe('requested');

    const jobs = await messageRevocationsQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.kind === 'status' && job.data.scheduledStatusId === created.id)).toBe(true);
  });
});
