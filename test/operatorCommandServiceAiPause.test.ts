import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { OperatorCommandService, generatePinSalt, hashPin } from '../src/services/operator/operatorCommandService.js';
import { OperatorModeRepository } from '../src/repositories/operatorModeRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { RelayedMessageRepository } from '../src/repositories/relayedMessageRepository.js';
import { ReminderRepository } from '../src/repositories/reminderRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const OPERATOR_JID = '12461234567@s.whatsapp.net';
const PIN = '1234';

async function authenticatedService(businessId: string, accountId: string): Promise<OperatorCommandService> {
  const opRepo = new OperatorModeRepository(pool);
  const salt = generatePinSalt();
  await opRepo.upsertSettings({
    businessId,
    operatorWaJid: OPERATOR_JID,
    pinSalt: salt,
    pinHash: hashPin(PIN, salt),
    pinN: 16384,
    pinR: 8,
    pinP: 1,
    enabled: true,
  });

  const service = new OperatorCommandService(pool);
  await service.handle(businessId, accountId, OPERATOR_JID, 'anything');
  await service.handle(businessId, accountId, OPERATOR_JID, PIN);
  return service;
}

async function createChat(businessId: string, accountId: string, jid: string) {
  return new WhatsAppChatRepository(pool).upsertFromWhatsApp({
    businessId,
    whatsappAccountId: accountId,
    chatJid: jid,
    jidKind: 'individual',
    chatType: 'individual',
  });
}

describe('OperatorCommandService - "ai off"/"ai on"/"ai status"', () => {
  let businessId: string;
  let accountId: string;
  let chatRepo: WhatsAppChatRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    chatRepo = new WhatsAppChatRepository(pool);
  });

  it('"ai off" pauses every AI_ACTIVE chat, and "ai status" reports it', async () => {
    const chatA = await createChat(businessId, accountId, '15550001111@s.whatsapp.net');
    const chatB = await createChat(businessId, accountId, '15550002222@s.whatsapp.net');
    const service = await authenticatedService(businessId, accountId);

    const offResult = await service.handle(businessId, accountId, OPERATOR_JID, 'ai off');
    expect(offResult.reply).toContain('2 chats');

    const a = await chatRepo.findById(chatA.id);
    const b = await chatRepo.findById(chatB.id);
    expect(a?.aiMode).toBe('AI_PAUSED');
    expect(a?.aiModeSource).toBe('operator_pause');
    expect(b?.aiMode).toBe('AI_PAUSED');

    const statusResult = await service.handle(businessId, accountId, OPERATOR_JID, 'ai status');
    expect(statusResult.reply).toContain('paused indefinitely');
    expect(statusResult.reply).toContain('2 chats');
  });

  it('"ai off" never touches a chat already in HUMAN_TAKEOVER for a real reason', async () => {
    const chat = await createChat(businessId, accountId, '15550003333@s.whatsapp.net');
    await chatRepo.setAiMode(chat.id, 'HUMAN_TAKEOVER', 'blocked_keyword');
    const service = await authenticatedService(businessId, accountId);

    await service.handle(businessId, accountId, OPERATOR_JID, 'ai off');

    const updated = await chatRepo.findById(chat.id);
    expect(updated?.aiMode).toBe('HUMAN_TAKEOVER');
    expect(updated?.aiModeSource).toBe('blocked_keyword'); // untouched
  });

  it('"ai on" only resumes chats "ai off" paused, never a chat a human separately paused from the dashboard', async () => {
    const pausedByOperator = await createChat(businessId, accountId, '15550004444@s.whatsapp.net');
    const pausedByHuman = await createChat(businessId, accountId, '15550005555@s.whatsapp.net');
    await chatRepo.setAiMode(pausedByHuman.id, 'AI_PAUSED', 'manual_toggle');
    const service = await authenticatedService(businessId, accountId);

    await service.handle(businessId, accountId, OPERATOR_JID, 'ai off');
    const onResult = await service.handle(businessId, accountId, OPERATOR_JID, 'ai on');
    expect(onResult.reply).toContain('1 chat');

    const a = await chatRepo.findById(pausedByOperator.id);
    const b = await chatRepo.findById(pausedByHuman.id);
    expect(a?.aiMode).toBe('AI_ACTIVE');
    expect(b?.aiMode).toBe('AI_PAUSED'); // untouched - a human paused this one deliberately
    expect(b?.aiModeSource).toBe('manual_toggle');
  });

  it('"ai status" reports "on" honestly when nothing is paused', async () => {
    const service = await authenticatedService(businessId, accountId);
    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'ai status');
    expect(result.reply).toContain('on and handling replies normally');
  });

  it('"ai off for 30 minutes" sets a real future deadline on the business row', async () => {
    await createChat(businessId, accountId, '15550006666@s.whatsapp.net');
    const service = await authenticatedService(businessId, accountId);

    const before = Date.now();
    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'ai off for 30 minutes');
    expect(result.reply).toContain('paused until');

    const business = await new BusinessRepository(pool).findById(businessId);
    expect(business?.aiOperatorPausedUntil).not.toBeNull();
    const deltaMs = new Date(business!.aiOperatorPausedUntil!).getTime() - before;
    expect(deltaMs).toBeGreaterThan(29 * 60_000);
    expect(deltaMs).toBeLessThan(31 * 60_000);
  });

  it('"ai off until 6am" (a time already past today) resolves to tomorrow, never a negative/past deadline', async () => {
    await createChat(businessId, accountId, '15550007777@s.whatsapp.net');
    const service = await authenticatedService(businessId, accountId);

    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'ai off until 6am');
    expect(result.reply).toContain('paused until');

    const business = await new BusinessRepository(pool).findById(businessId);
    expect(business?.aiOperatorPausedUntil).not.toBeNull();
    expect(new Date(business!.aiOperatorPausedUntil!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('OperatorCommandService - "messages"', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('reads back what is really on the take-a-message board, without dismissing anything', async () => {
    const chat = await createChat(businessId, accountId, '15550008888@s.whatsapp.net');
    await new RelayedMessageRepository(pool).create({
      businessId,
      chatId: chat.id,
      recipientDescription: 'the owner',
      messageText: 'call me back',
      whenText: '5:00 PM today',
    });
    const service = await authenticatedService(businessId, accountId);

    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'messages');
    expect(result.reply).toContain('call me back');
    expect(result.reply).toContain('the owner');

    const stillOpen = await new RelayedMessageRepository(pool).listOpenForBusiness(businessId);
    expect(stillOpen).toHaveLength(1); // reading via WhatsApp never dismisses it
  });

  it('reports honestly when nothing is waiting', async () => {
    const service = await authenticatedService(businessId, accountId);
    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'messages');
    expect(result.reply).toContain('No messages waiting');
  });
});

describe('OperatorCommandService - "remind me [text] at [time]"', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('creates a real reminder row via the same table/mechanism assistant mode uses', async () => {
    const service = await authenticatedService(businessId, accountId);
    const result = await service.handle(businessId, accountId, OPERATOR_JID, 'remind me call the supplier at 5pm');
    expect(result.reply).toContain('Reminder set');
    expect(result.reply).toContain('call the supplier');

    const reminders = await new ReminderRepository(pool).listUpcoming(businessId, 10);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.message).toBe('call the supplier');
    expect(reminders[0]!.notifyJid).toContain('12461234567');
  });
});
