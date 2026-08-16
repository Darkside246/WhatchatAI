import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppOutboundMessageRepository } from '../src/repositories/whatsappOutboundMessageRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('WhatsAppOutboundMessageRepository (real Postgres)', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  const toJid = '15550009999@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: toJid,
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  it('creates a real, queued send request with wasCreated=true', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-1',
      messageType: 'text',
      textContent: 'Hello from the real outbound repository test',
    });

    expect(record.wasCreated).toBe(true);
    expect(record.status).toBe('queued');
    expect(record.attemptCount).toBe(0);
    expect(record.textContent).toBe('Hello from the real outbound repository test');
  });

  it('never creates a second send for a retried request with the same idempotency key', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const first = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-retry',
      messageType: 'text',
      textContent: 'First attempt',
    });
    const second = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-retry',
      messageType: 'text',
      textContent: 'A retried request should never override the original text either',
    });

    expect(first.wasCreated).toBe(true);
    expect(second.wasCreated).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.textContent).toBe('First attempt');

    const { rows } = await pool.query('SELECT count(*) AS count FROM whatsapp_outbound_messages');
    expect(Number(rows[0].count)).toBe(1);
  });

  it('a different idempotency key for the same chat creates a genuinely separate send', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const first = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-a',
      messageType: 'text',
      textContent: 'Message A',
    });
    const second = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-b',
      messageType: 'text',
      textContent: 'Message B',
    });

    expect(first.id).not.toBe(second.id);
    expect(first.wasCreated).toBe(true);
    expect(second.wasCreated).toBe(true);
  });

  it('tracks the real status lifecycle: queued -> sending -> sent', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-lifecycle',
      messageType: 'text',
      textContent: 'Lifecycle test',
    });

    await repository.markSending(record.id);
    let updated = await repository.findById(record.id);
    expect(updated?.status).toBe('sending');
    expect(updated?.attemptCount).toBe(1);

    await repository.markSent(record.id, 'WA-REAL-MESSAGE-ID-1');
    updated = await repository.findById(record.id);
    expect(updated?.status).toBe('sent');
    expect(updated?.whatsappMessageId).toBe('WA-REAL-MESSAGE-ID-1');
    expect(updated?.sentAt).not.toBeNull();
    expect(updated?.lastError).toBeNull();
  });

  it('records a terminal failure honestly - never a fabricated success', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-fail',
      messageType: 'text',
      textContent: 'This send will fail',
    });

    await repository.markSending(record.id);
    await repository.markFailed(record.id, 'WhatsApp socket disconnected mid-send');

    const updated = await repository.findById(record.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.lastError).toBe('WhatsApp socket disconnected mid-send');
    expect(updated?.sentAt).toBeNull();
    expect(updated?.whatsappMessageId).toBeNull();
  });

  it('finds a real send stuck queued/sending well past the staleness window, and leaves a fresh one alone', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const stale = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-stale',
      messageType: 'text',
      textContent: 'Abandoned mid-send',
    });
    await repository.markSending(stale.id);
    await pool.query(`UPDATE whatsapp_outbound_messages SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [
      stale.id,
    ]);

    const fresh = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-fresh',
      messageType: 'text',
      textContent: 'Just queued',
    });

    const staleResults = await repository.findStalePending(300);
    expect(staleResults.map((r) => r.id)).toEqual([stale.id]);
    expect(staleResults.map((r) => r.id)).not.toContain(fresh.id);
  });

  it('links a persisted message back to its outbound send request', async () => {
    const repository = new WhatsAppOutboundMessageRepository(pool);
    const record = await repository.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'idem-link',
      messageType: 'text',
      textContent: 'Will be linked once persisted',
    });
    await repository.markSending(record.id);
    await repository.markSent(record.id, 'WA-LINK-ID');

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO whatsapp_messages
         (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid, sender_jid, direction,
          message_type, text_content, "timestamp", from_me)
       VALUES ($1, $2, $3, 'WA-LINK-ID', $4, $4, 'outbound', 'text', 'Will be linked once persisted', now(), true)
       RETURNING id`,
      [businessId, accountId, chatId, toJid],
    );
    const messageId = rows[0]!.id;

    await repository.linkPersistedMessage(accountId, 'WA-LINK-ID', messageId);

    const updated = await repository.findById(record.id);
    expect(updated?.messageId).toBe(messageId);
  });
});
