import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiCommitmentRepository } from '../src/repositories/aiCommitmentRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('AiCommitmentRepository (real Postgres - migration 957)', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  const toJid = '15550008888@s.whatsapp.net';
  const repo = new AiCommitmentRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: toJid,
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  it('records a real commitment', async () => {
    const record = await repo.record({ businessId, chatId, commitmentText: "I'll check and get back to you.", detectedPhrase: "I'll check" });
    expect(record.businessId).toBe(businessId);
    expect(record.chatId).toBe(chatId);
    expect(record.detectedPhrase).toBe("I'll check");
  });

  it('an old, real commitment with no later outbound message is reported as open', async () => {
    await repo.record({ businessId, chatId, commitmentText: "I'll follow up tomorrow.", detectedPhrase: "I'll follow up" });
    await pool.query(`UPDATE ai_commitments SET created_at = now() - interval '10 hours'`);

    const open = await repo.listOpen(businessId, 4);
    expect(open).toHaveLength(1);
  });

  it('a commitment younger than the requested age threshold is not yet reported as open', async () => {
    await repo.record({ businessId, chatId, commitmentText: "I'll follow up shortly.", detectedPhrase: "I'll follow up" });
    const open = await repo.listOpen(businessId, 4);
    expect(open).toHaveLength(0);
  });

  it('a real later outbound message in the same chat marks the commitment as addressed, not open', async () => {
    await repo.record({ businessId, chatId, commitmentText: "I'll follow up tomorrow.", detectedPhrase: "I'll follow up" });
    await pool.query(`UPDATE ai_commitments SET created_at = now() - interval '10 hours'`);

    await new WhatsAppMessageRepository(pool).insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'FOLLOWUP-1',
      remoteJid: toJid,
      senderJid: toJid,
      direction: 'outbound',
      messageType: 'text',
      textContent: 'Update: the vendor confirmed for 2pm tomorrow.',
      timestamp: new Date().toISOString(),
      fromMe: true,
      isHistorical: false,
    });

    const open = await repo.listOpen(businessId, 4);
    expect(open).toHaveLength(0);
  });

  it('an earlier outbound message (before the commitment) does not count as addressing it', async () => {
    const inserted = await new WhatsAppMessageRepository(pool).insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'BEFORE-1',
      remoteJid: toJid,
      senderJid: toJid,
      direction: 'outbound',
      messageType: 'text',
      textContent: 'Hi there!',
      timestamp: new Date().toISOString(),
      fromMe: true,
      isHistorical: false,
    });
    // Backdated further than the commitment below - a real message that
    // genuinely predates the commitment, not just an artifact of both
    // rows sharing the same real "now" insertion time.
    await pool.query(`UPDATE whatsapp_messages SET created_at = now() - interval '20 hours' WHERE id = $1`, [inserted.id]);
    await repo.record({ businessId, chatId, commitmentText: "I'll follow up tomorrow.", detectedPhrase: "I'll follow up" });
    await pool.query(`UPDATE ai_commitments SET created_at = now() - interval '10 hours'`);

    const open = await repo.listOpen(businessId, 4);
    expect(open).toHaveLength(1);
  });

  it('never returns another business\'s commitments - real tenant isolation', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAccountId = await createTestAccount(otherBusinessId, '15550007777@s.whatsapp.net');
    const otherChat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId: otherBusinessId,
      whatsappAccountId: otherAccountId,
      chatJid: '15550007777@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    await repo.record({ businessId: otherBusinessId, chatId: otherChat.id, commitmentText: 'x', detectedPhrase: "I'll check" });
    await pool.query(`UPDATE ai_commitments SET created_at = now() - interval '10 hours' WHERE business_id = $1`, [otherBusinessId]);

    expect(await repo.listOpen(businessId, 4)).toHaveLength(0);
  });
});
