import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

async function createTestChat(businessId: string, accountId: string): Promise<string> {
  const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
    businessId,
    whatsappAccountId: accountId,
    chatJid: '15550009999@s.whatsapp.net',
    jidKind: 'individual',
    chatType: 'individual',
  });
  return chat.id;
}

describe('WhatsAppChatRepository - manual-reply-detected auto-pause guards', () => {
  let businessId: string;
  let chatId: string;
  let repo: WhatsAppChatRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    chatId = await createTestChat(businessId, accountId);
    repo = new WhatsAppChatRepository(pool);
  });

  describe('setAiMode', () => {
    it('records the provenance alongside the mode change', async () => {
      const updated = await repo.setAiMode(chatId, 'HUMAN_TAKEOVER', 'blocked_keyword');
      expect(updated?.aiMode).toBe('HUMAN_TAKEOVER');
      expect(updated?.aiModeSource).toBe('blocked_keyword');
      expect(updated?.aiModeSetAt).not.toBeNull();
    });

    it('leaves source null when the caller omits it - existing callers that predate this column still work', async () => {
      const updated = await repo.setAiMode(chatId, 'HUMAN_TAKEOVER');
      expect(updated?.aiModeSource).toBeNull();
    });
  });

  describe('pauseAiForManualReply', () => {
    it('transitions an AI_ACTIVE chat to HUMAN_TAKEOVER with source manual_reply_detected', async () => {
      const paused = await repo.pauseAiForManualReply(chatId);
      expect(paused?.aiMode).toBe('HUMAN_TAKEOVER');
      expect(paused?.aiModeSource).toBe('manual_reply_detected');
    });

    it('is a no-op against a chat already in HUMAN_TAKEOVER for any reason - never overrides an existing takeover', async () => {
      await repo.setAiMode(chatId, 'HUMAN_TAKEOVER', 'blocked_keyword');
      const result = await repo.pauseAiForManualReply(chatId);
      expect(result).toBeNull();

      const chat = await repo.findById(chatId);
      expect(chat?.aiModeSource).toBe('blocked_keyword'); // untouched
    });

    it('is a no-op against an AI_PAUSED chat - a deliberate dashboard pause is not the same as this auto-pause', async () => {
      await repo.setAiMode(chatId, 'AI_PAUSED', 'manual_toggle');
      const result = await repo.pauseAiForManualReply(chatId);
      expect(result).toBeNull();
    });
  });

  describe('resumeAiIfManualReplyDetected', () => {
    it('resumes AI_ACTIVE only when the row is exactly (HUMAN_TAKEOVER, manual_reply_detected)', async () => {
      await repo.pauseAiForManualReply(chatId);
      const resumed = await repo.resumeAiIfManualReplyDetected(chatId);
      expect(resumed?.aiMode).toBe('AI_ACTIVE');
      expect(resumed?.aiModeSource).toBe('auto_resume_after_manual_reply');
    });

    it('never resumes a chat taken over for a different reason (blocked keyword, AI failure, dashboard toggle)', async () => {
      for (const source of ['blocked_keyword', 'no_agent', 'ai_unavailable', 'manual_toggle']) {
        await repo.setAiMode(chatId, 'HUMAN_TAKEOVER', source);
        const result = await repo.resumeAiIfManualReplyDetected(chatId);
        expect(result).toBeNull();

        const chat = await repo.findById(chatId);
        expect(chat?.aiMode).toBe('HUMAN_TAKEOVER'); // still taken over
        expect(chat?.aiModeSource).toBe(source); // untouched
      }
    });

    it('is a no-op against a chat that already resumed - never fires twice', async () => {
      await repo.pauseAiForManualReply(chatId);
      const first = await repo.resumeAiIfManualReplyDetected(chatId);
      expect(first).not.toBeNull();

      const second = await repo.resumeAiIfManualReplyDetected(chatId);
      expect(second).toBeNull();
    });
  });

  describe('revertHumanTakeoverChats (logout revert)', () => {
    it('still reverts a manual-reply-detected auto-pause too, since logging out means the owner is no longer actively replying', async () => {
      await repo.pauseAiForManualReply(chatId);
      const reverted = await repo.revertHumanTakeoverChats(businessId);
      expect(reverted).toBe(1);

      const chat = await repo.findById(chatId);
      expect(chat?.aiMode).toBe('AI_ACTIVE');
      expect(chat?.aiModeSource).toBe('logout_revert');
    });
  });
});
