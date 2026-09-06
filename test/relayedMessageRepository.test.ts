import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { RelayedMessageRepository } from '../src/repositories/relayedMessageRepository.js';
import { createTestAccount, createTestBusiness } from './helpers.js';

async function createChat(businessId: string, accountId: string, jid: string, name?: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_chats (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type, name) VALUES ($1, $2, $3, 'individual', 'individual', $4) RETURNING id`,
    [businessId, accountId, jid, name ?? null],
  );
  return rows[0]!.id;
}

describe('RelayedMessageRepository (real Postgres, take-a-message board)', () => {
  it('create() writes a real row and reads it back with the resolved from-name', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '1@s.whatsapp.net', 'John Smith');
    const repo = new RelayedMessageRepository(queryAsTenant(businessId));

    const record = await repo.create({
      businessId,
      chatId,
      recipientDescription: 'the owner',
      messageText: 'Call me back',
      whenText: '8:00 PM today',
    });

    expect(record.fromDisplayName).toBe('John Smith');
    expect(record.recipientDescription).toBe('the owner');
    expect(record.messageText).toBe('Call me back');
    expect(record.whenText).toBe('8:00 PM today');
    expect(record.dismissedAt).toBeNull();
  });

  it('create() without a whenText stores it as null, never an empty string', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '2@s.whatsapp.net');
    const repo = new RelayedMessageRepository(queryAsTenant(businessId));

    const record = await repo.create({
      businessId,
      chatId,
      recipientDescription: 'John',
      messageText: 'On my way',
    });

    expect(record.whenText).toBeNull();
  });

  it('listOpenForBusiness returns only undismissed messages, newest first', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '3@s.whatsapp.net');
    const repo = new RelayedMessageRepository(queryAsTenant(businessId));

    const first = await repo.create({ businessId, chatId, recipientDescription: 'the owner', messageText: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.create({ businessId, chatId, recipientDescription: 'the owner', messageText: 'second' });
    await repo.dismiss(first.id, businessId);

    const open = await repo.listOpenForBusiness(businessId);
    expect(open.map((m) => m.id)).toEqual([second.id]);
  });

  it('dismiss() only sets dismissed_at, never touches whatsapp_chats or any WhatsApp message row', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '4@s.whatsapp.net');
    const repo = new RelayedMessageRepository(queryAsTenant(businessId));
    const record = await repo.create({ businessId, chatId, recipientDescription: 'the owner', messageText: 'hi' });

    const dismissed = await repo.dismiss(record.id, businessId);
    expect(dismissed).toBe(true);

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM whatsapp_chats WHERE id = $1', [chatId]);
    expect(rows).toHaveLength(1);

    const found = await repo.findByIdForBusiness(record.id, businessId);
    expect(found?.dismissedAt).not.toBeNull();
  });

  it('dismiss() on an already-dismissed message is a safe no-op, returns false', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '5@s.whatsapp.net');
    const repo = new RelayedMessageRepository(queryAsTenant(businessId));
    const record = await repo.create({ businessId, chatId, recipientDescription: 'the owner', messageText: 'hi' });

    expect(await repo.dismiss(record.id, businessId)).toBe(true);
    expect(await repo.dismiss(record.id, businessId)).toBe(false);
  });

  it('dismiss() for an unknown id returns false', async () => {
    const businessId = await createTestBusiness();
    const repo = new RelayedMessageRepository(queryAsTenant(businessId));
    expect(await repo.dismiss('00000000-0000-0000-0000-000000000000', businessId)).toBe(false);
  });

  it('never leaks another business\'s relayed messages', async () => {
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const accountA = await createTestAccount(businessA, '15550001111@s.whatsapp.net');
    const chatA = await createChat(businessA, accountA, '6@s.whatsapp.net');
    const repoA = new RelayedMessageRepository(queryAsTenant(businessA));
    const record = await repoA.create({ businessId: businessA, chatId: chatA, recipientDescription: 'the owner', messageText: 'hi' });

    const repoB = new RelayedMessageRepository(queryAsTenant(businessB));
    expect(await repoB.findByIdForBusiness(record.id, businessB)).toBeNull();
    expect(await repoB.listOpenForBusiness(businessB)).toEqual([]);
    expect(await repoB.dismiss(record.id, businessB)).toBe(false);
  });
});
