import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { orchestrateAiReply } from '../src/services/ai/aiOrchestrator.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { AiUsageRepository } from '../src/repositories/aiUsageRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { register } from '../src/services/authService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Section 34-40 (Token economy): before this, nothing ever stopped one
 * active agent from spending past whatever budget a plan was meant to
 * imply. This gate runs before the real Gemini call, so it's testable
 * without GEMINI_API_KEY - a budget-exceeded business should never reach
 * generateAiReply at all.
 */
describe('orchestrateAiReply - monthly AI token budget gate', () => {
  let businessId: string;
  let chatId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'budget-gate-test@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Reception Agent', priority: 10 });

    const accountId = await createTestAccount(businessId);
    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
    const messageRepo = new WhatsAppMessageRepository(pool);
    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: `BUDGET-GATE-TEST-${Date.now()}`,
      remoteJid: '15550009999@s.whatsapp.net',
      senderJid: '15550009999@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'Are you open today?',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });
  });

  it('hands off to a human with a clear reason once the starter plan\'s 500,000 token/month budget is exhausted, without ever reaching Gemini', async () => {
    const usage = new AiUsageRepository(pool);
    await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 300000, candidatesTokens: 300000, totalTokens: 600000 });

    const outcome = await orchestrateAiReply({ businessId, chatId, contactId: null, queryText: 'Are you open today?' });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') {
      expect(outcome.reason).toContain('AI reply allowance');
      expect(outcome.reason).toContain('500000');
    }
  });
});

/**
 * Section 72: in production every business gets a subscription the
 * moment it exists (ensureDefaultBusinessProvisioned / trialOnboardingService.ts's
 * own insert) - the only way NO_ACTIVE_SUBSCRIPTION legitimately occurs is
 * a genuinely-expired, never-converted trial once subscriptionExpiryService.ts's
 * sweep has marked it EXPIRED. This gate must block that case too, the
 * same as every other real entitlement check already does.
 */
describe('orchestrateAiReply - blocks a business with no active subscription at all', () => {
  it('hands off to a human rather than generating a free reply for a business with NO_ACTIVE_SUBSCRIPTION', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Reception Agent', priority: 10 });

    const accountId = await createTestAccount(businessId);
    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550008888@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const messageRepo = new WhatsAppMessageRepository(pool);
    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId: `NO-SUB-TEST-${Date.now()}`,
      remoteJid: '15550008888@s.whatsapp.net',
      senderJid: '15550008888@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'Are you open today?',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });

    const outcome = await orchestrateAiReply({ businessId, chatId: chat.id, contactId: null, queryText: 'Are you open today?' });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') {
      expect(outcome.reason).toContain('no active subscription');
    }
  });
});
