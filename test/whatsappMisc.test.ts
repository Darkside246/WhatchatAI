import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppMessageReactionRepository } from '../src/repositories/whatsappMessageReactionRepository.js';
import { WhatsAppMediaRepository } from '../src/repositories/whatsappMediaRepository.js';
import { WhatsAppCallRepository } from '../src/repositories/whatsappCallRepository.js';
import { WhatsAppPresenceRepository } from '../src/repositories/whatsappPresenceRepository.js';
import { WhatsAppStatusRepository } from '../src/repositories/whatsappStatusRepository.js';
import { WhatsAppSyncJobRepository } from '../src/repositories/whatsappSyncJobRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('Remaining Phase 2C repositories', () => {
  let businessId: string;
  let accountId: string;
  let messageId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const chats = new WhatsAppChatRepository(pool);
    const chat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const messages = new WhatsAppMessageRepository(pool);
    const message = await messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId: 'WA-BASE-MSG',
      remoteJid: '15550002222@s.whatsapp.net',
      senderJid: '15550002222@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'base message',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    messageId = message.id;
  });

  it('persists a reaction pointing to a real message', async () => {
    const reactions = new WhatsAppMessageReactionRepository(pool);
    const reaction = await reactions.upsert(businessId, accountId, messageId, '15550002222@s.whatsapp.net', '👍');
    expect(reaction.reaction).toBe('👍');

    // A reaction can never be inserted against a message that doesn't exist (FK-enforced).
    await expect(
      reactions.upsert(businessId, accountId, '00000000-0000-0000-0000-000000000000', '15550002222@s.whatsapp.net', '👍'),
    ).rejects.toThrow();
  });

  it('persists real media metadata without a fabricated transcript', async () => {
    const media = new WhatsAppMediaRepository(pool);
    const record = await media.insert({
      businessId,
      whatsappAccountId: accountId,
      messageId,
      mediaType: 'voice_note',
      mimeType: 'audio/ogg',
      durationSeconds: 12,
    });

    expect(record.transcript).toBeNull();
    expect(record.downloadStatus).toBe('pending');
  });

  it('persists real call events and updates the same call across event states', async () => {
    const calls = new WhatsAppCallRepository(pool);
    const offer = await calls.upsertEvent({
      businessId,
      whatsappAccountId: accountId,
      callId: 'CALL-1',
      remoteJid: '15550002222@s.whatsapp.net',
      callType: 'voice',
      direction: 'inbound',
      status: 'offer',
    });
    const ended = await calls.upsertEvent({
      businessId,
      whatsappAccountId: accountId,
      callId: 'CALL-1',
      remoteJid: '15550002222@s.whatsapp.net',
      callType: 'voice',
      direction: 'inbound',
      status: 'ended',
      durationSeconds: 42,
    });

    expect(ended.id).toBe(offer.id);
    expect(ended.status).toBe('ended');
    expect(ended.durationSeconds).toBe(42);
  });

  it('records presence as an append-only real event log', async () => {
    const presence = new WhatsAppPresenceRepository(pool);
    await presence.record(businessId, accountId, '15550002222@s.whatsapp.net', 'composing', null);
    const latest = await presence.record(businessId, accountId, '15550002222@s.whatsapp.net', 'available', null);

    expect(latest.presenceState).toBe('available');
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM whatsapp_presence');
    expect(rows[0].count).toBe(2);
  });

  it('persists a real status event', async () => {
    const statuses = new WhatsAppStatusRepository(pool);
    const status = await statuses.insert({
      businessId,
      whatsappAccountId: accountId,
      statusId: 'STATUS-1',
      publisherJid: '15550002222@s.whatsapp.net',
      statusType: 'text',
      textContent: 'Out of office',
    });

    expect(status.textContent).toBe('Out of office');
  });

  it('tracks a sync job through its real lifecycle', async () => {
    const syncJobs = new WhatsAppSyncJobRepository(pool);
    const job = await syncJobs.create(businessId, accountId, 'contacts');
    expect(job.status).toBe('pending');

    await syncJobs.markRunning(job.id);
    let updated = await syncJobs.findById(job.id);
    expect(updated?.status).toBe('running');
    expect(updated?.startedAt).toBeTruthy();

    await syncJobs.markCompleted(job.id);
    updated = await syncJobs.findById(job.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.progressPercent).toBe(100);
  });
});
