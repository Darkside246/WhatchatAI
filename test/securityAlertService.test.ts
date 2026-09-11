import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { listHumanTakeoverAlerts } from '../src/services/securityAlertService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('securityAlertService (Zero-Leak Rule: no *customer* message text, contact names, or phone numbers)', () => {
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

  it('surfaces the business line label (account name, falling back to its phone number) + urgency tier, with zero customer-identifying fields', async () => {
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
    // createTestAccount sets phone_number but no account_name, so the fallback applies -
    // this is the business's own connected line, never the customer's number.
    expect(alerts[0]?.lineLabel).toBe('+15550003333');
    expect(alerts[0]?.urgency).toBe('HIGH'); // unreadCount 7 >= 5
    // customerName/customerPhoneNumber are real, present keys - just null by
    // default (includeIdentity not requested), never omitted/undefined.
    expect(alerts[0]?.customerName).toBeNull();
    expect(alerts[0]?.customerPhoneNumber).toBeNull();

    const keys = Object.keys(alerts[0] ?? {});
    expect(keys.sort()).toEqual(['chatId', 'customerName', 'customerPhoneNumber', 'lineLabel', 'triggeredAt', 'urgency']);
  });

  it('never returns customer identity unless includeIdentity is explicitly true, even when the chat has a real name/number', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      name: 'Real Customer Name',
      phoneNumber: '+15550004444',
      unreadCount: 7,
    });
    await chatRepository.setAiMode(chat.id, 'HUMAN_TAKEOVER');

    const withoutIdentity = await listHumanTakeoverAlerts(businessId);
    expect(withoutIdentity[0]?.customerName).toBeNull();
    expect(withoutIdentity[0]?.customerPhoneNumber).toBeNull();

    const withIdentity = await listHumanTakeoverAlerts(businessId, true);
    expect(withIdentity[0]?.customerName).toBe('Real Customer Name');
    expect(withIdentity[0]?.customerPhoneNumber).toBe('+15550004444');
  });

  /**
   * Real regression coverage for "the alert shows a number for someone the
   * chat list names correctly." whatsapp_chats.name is frequently null for a
   * conversation whose address-book name lives on the contact row, and this
   * service used to read that column directly instead of going through
   * chatIdentityService like every other surface that names a conversation.
   */
  it('names the customer from their contact row when the chat row itself has no name', async () => {
    const contactRepository = new WhatsAppContactRepository(pool);
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550004444',
      displayName: "O'brien Brathwaite",
    });

    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      contactId: contact.id,
      phoneNumber: '+15550004444',
      unreadCount: 7,
    });
    await chatRepository.setAiMode(chat.id, 'HUMAN_TAKEOVER');

    const [alert] = await listHumanTakeoverAlerts(businessId, true);
    expect(alert?.customerName).toBe("O'brien Brathwaite");
    expect(alert?.customerPhoneNumber).toBe('+15550004444');
  });

  it('leaves the name null rather than repeating the number, when no real name is known', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      phoneNumber: '+15550009999',
      unreadCount: 1,
    });
    await chatRepository.setAiMode(chat.id, 'HUMAN_TAKEOVER');

    // Showing the number as the NAME would make "nobody has saved this
    // person" indistinguishable from "they are named after their own
    // number" - the pill shows a number either way, but honestly.
    const [alert] = await listHumanTakeoverAlerts(businessId, true);
    expect(alert?.customerName).toBeNull();
    expect(alert?.customerPhoneNumber).toBe('+15550009999');
  });

  it('falls back to the ordinal Line N label when the account has neither a name nor a phone number', async () => {
    const accountRepository = new WhatsAppAccountRepository(pool);
    const bareAccount = await accountRepository.upsertConnected({
      businessId,
      whatsappJid: '15559990000@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: null,
      pushName: null,
      connectionStatus: 'CONNECTED',
    });

    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: bareAccount.id,
      chatJid: '15550008888@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount: 1,
    });
    await chatRepository.setAiMode(chat.id, 'HUMAN_TAKEOVER');

    const alerts = await listHumanTakeoverAlerts(businessId);
    const alert = alerts.find((entry) => entry.chatId === chat.id);
    expect(alert?.lineLabel).toBe('Line 2');
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
