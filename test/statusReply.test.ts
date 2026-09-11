import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppStatusRepository } from '../src/repositories/whatsappStatusRepository.js';
import { WhatsAppOutboundMessageRepository } from '../src/repositories/whatsappOutboundMessageRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * A WhatsApp status reply is an ordinary direct message to whoever posted,
 * which QUOTES the status so both sides see it threaded under the right
 * post. These cover the parts this app is responsible for: resolving the
 * publisher's real conversation, recording the quote reference, and
 * refusing honestly when there is nobody to reply to.
 */
describe('replying to a customer status', () => {
  let businessId: string;
  let accountId: string;
  const publisherJid = '12465551234@s.whatsapp.net';
  const statusRepository = new WhatsAppStatusRepository(pool);
  const chatRepository = new WhatsAppChatRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  async function insertStatus() {
    return statusRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      statusId: 'WA-STATUS-1',
      publisherJid,
      statusType: 'text',
      textContent: 'Open for business today',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  }

  it('sends the reply into the publisher\'s own conversation, recording the status it quotes', async () => {
    const status = await insertStatus();
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: publisherJid,
      jidKind: 'individual',
      chatType: 'individual',
    });

    const result = await workspaceService.replyToStatus(businessId, accountId, status.id, 'Great, see you at 6');

    expect(result.chatId).toBe(chat.id);

    const outbound = await new WhatsAppOutboundMessageRepository(pool).findById(result.outboundMessageId);
    expect(outbound?.messageType).toBe('text');
    expect(outbound?.textContent).toBe('Great, see you at 6');
    // The quote reference is what makes WhatsApp thread it under the status
    // rather than delivering a bare, context-free message.
    expect(outbound?.replyToStatusId).toBe(status.id);
  });

  it('refuses honestly when there is no conversation with the publisher yet - never invents one', async () => {
    const status = await insertStatus();

    await expect(workspaceService.replyToStatus(businessId, accountId, status.id, 'hello')).rejects.toMatchObject({
      code: 'CHAT_NOT_FOUND',
    });

    // Nothing was created on the way out.
    const chat = await chatRepository.findByJid(businessId, accountId, publisherJid);
    expect(chat).toBeNull();
  });

  it('never replies to another tenant\'s status', async () => {
    const status = await insertStatus();
    const otherBusinessId = await createTestBusiness();
    const otherAccountId = await createTestAccount(otherBusinessId, '15559998888@s.whatsapp.net');

    await expect(
      workspaceService.replyToStatus(otherBusinessId, otherAccountId, status.id, 'hello'),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
  });
});
