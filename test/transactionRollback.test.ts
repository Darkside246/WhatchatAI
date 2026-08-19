import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('Transaction rollback', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;

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
    chatId = chat.id;
  });

  it('leaves no partial data when a later step in the transaction fails', async () => {
    await expect(
      withTransaction(async (client) => {
        const messages = new WhatsAppMessageRepository(client);
        await messages.insert({
          businessId,
          whatsappAccountId: accountId,
          chatId,
          whatsappMessageId: 'WA-ROLLBACK',
          remoteJid: '15550002222@s.whatsapp.net',
          senderJid: '15550002222@s.whatsapp.net',
          direction: 'inbound',
          messageType: 'text',
          textContent: 'this must not survive the rollback',
          timestamp: new Date().toISOString(),
          fromMe: false,
          isHistorical: false,
        });

        throw new Error('forced failure after a successful insert');
      }),
    ).rejects.toThrow('forced failure after a successful insert');

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM whatsapp_messages WHERE whatsapp_message_id = $1', [
      'WA-ROLLBACK',
    ]);
    expect(rows[0].count).toBe(0);
  });
});
