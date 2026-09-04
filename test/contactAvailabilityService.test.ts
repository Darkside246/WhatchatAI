import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { describe, expect, it } from 'vitest';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { computeContactActivityProfile, computeSendTimingDelayMs } from '../src/services/contactAvailabilityService.js';
import { createTestAccount, createTestBusiness } from './helpers.js';

async function createTestChat(businessId: string, accountId: string, jid: string): Promise<string> {
  const contactRepo = new WhatsAppContactRepository(pool);
  const contact = await contactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: jid, jidKind: 'individual' });
  const chatRepo = new WhatsAppChatRepository(pool);
  const chat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: jid, jidKind: 'individual', chatType: 'individual', contactId: contact.id });
  return chat.id;
}

async function insertInboundMessage(businessId: string, accountId: string, chatId: string, jid: string, timestampIso: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_messages (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid, sender_jid, direction, message_type, text_content, "timestamp", from_me)
     VALUES ($1, $2, $3, $4, $5, $5, 'inbound', 'text', 'hi', $6::timestamptz, false)`,
    [businessId, accountId, chatId, `WA-${randomUUID()}`, jid, timestampIso],
  );
}

describe('computeContactActivityProfile (real Postgres)', () => {
  it('returns null when there is not enough real message history to trust a signal from', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '15559991000@s.whatsapp.net');
    await insertInboundMessage(businessId, accountId, chatId, '15559991000@s.whatsapp.net', '2026-01-01T14:00:00.000Z');

    expect(await computeContactActivityProfile(pool, chatId)).toBeNull();
  });

  it('identifies the real most-active UTC hour once there is enough history', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '15559991001@s.whatsapp.net');
    const jid = '15559991001@s.whatsapp.net';
    // 5 messages at 14:00 UTC, 2 at 09:00 UTC - 14 should win.
    for (const day of [1, 2, 3, 4, 5]) await insertInboundMessage(businessId, accountId, chatId, jid, `2026-01-0${day}T14:15:00.000Z`);
    for (const day of [1, 2]) await insertInboundMessage(businessId, accountId, chatId, jid, `2026-01-0${day}T09:00:00.000Z`);

    const profile = await computeContactActivityProfile(pool, chatId);
    expect(profile?.mostActiveHourUtc).toBe(14);
    expect(profile?.sampleSize).toBe(7);
  });

  it('never counts an outbound message as a real inbound activity signal', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '15559991002@s.whatsapp.net');
    await pool.query(
      `INSERT INTO whatsapp_messages (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid, sender_jid, direction, message_type, text_content, "timestamp", from_me)
       SELECT $1, $2, $3, 'WA-OUT-' || gs, $4, $4, 'outbound', 'text', 'hi', now(), true FROM generate_series(1, 10) gs`,
      [businessId, accountId, chatId, '15559991002@s.whatsapp.net'],
    );

    expect(await computeContactActivityProfile(pool, chatId)).toBeNull();
  });
});

describe('computeSendTimingDelayMs (real Postgres)', () => {
  it('returns 0 for a chat with no real activity history - never fabricates a preference', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '15559991003@s.whatsapp.net');

    expect(await computeSendTimingDelayMs(pool, chatId)).toBe(0);
  });

  it('returns a real, bounded delay for a chat with a genuine activity pattern', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '15559991004@s.whatsapp.net');
    const jid = '15559991004@s.whatsapp.net';
    for (const day of [1, 2, 3, 4, 5]) await insertInboundMessage(businessId, accountId, chatId, jid, `2026-01-0${day}T20:00:00.000Z`);

    const now = new Date('2026-02-01T08:00:00.000Z');
    const delay = await computeSendTimingDelayMs(pool, chatId, now);
    expect(delay).toBe(12 * 60 * 60 * 1000); // 08:00 -> 20:00
  });
});
