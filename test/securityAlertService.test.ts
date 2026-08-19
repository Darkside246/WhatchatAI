import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { listHumanTakeoverAlerts } from '../src/services/securityAlertService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('securityAlertService (Zero-Leak Rule: no message text, contact names, or phone numbers)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, '15550003333@s.whatsapp.net');
  });

  it('returns no alerts when nothing is in HUMAN_TAKEOVER mode', async () => {
    expect(await listHumanTakeoverAlerts(businessId)).toEqual([]);
  });

  it('surfaces a real Line N label + urgency tier for a chat awaiting human takeover, with zero PII fields', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount: 7,
    });
    await chatRepository.setAiMode(chat.id, 'HUMAN_TAKEOVER');

    const alerts = await listHumanTakeoverAlerts(businessId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.chatId).toBe(chat.id);
    expect(alerts[0]?.lineLabel).toBe('Line 1');
    expect(alerts[0]?.urgency).toBe('HIGH'); // unreadCount 7 >= 5

    const keys = Object.keys(alerts[0] ?? {});
    expect(keys.sort()).toEqual(['chatId', 'lineLabel', 'triggeredAt', 'urgency']);
  });

  it('derives MEDIUM and LOW urgency tiers from real unread counts', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);

    const mediumChat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550005555@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount: 3,
    });
    await chatRepository.setAiMode(mediumChat.id, 'HUMAN_TAKEOVER');

    const lowChat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550006666@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount: 1,
    });
    await chatRepository.setAiMode(lowChat.id, 'HUMAN_TAKEOVER');

    const alerts = await listHumanTakeoverAlerts(businessId);
    const byId = new Map(alerts.map((alert) => [alert.chatId, alert]));
    expect(byId.get(mediumChat.id)?.urgency).toBe('MEDIUM');
    expect(byId.get(lowChat.id)?.urgency).toBe('LOW');
  });

  it('does not surface chats in AI_ACTIVE or AI_PAUSED mode', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550007777@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    await chatRepository.setAiMode(chat.id, 'AI_PAUSED');

    expect(await listHumanTakeoverAlerts(businessId)).toEqual([]);
  });
});
