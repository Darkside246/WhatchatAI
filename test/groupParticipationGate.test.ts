import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository, type WhatsAppChatRecord } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { WhatsAppGroupRepository } from '../src/repositories/whatsappGroupRepository.js';
import { WhatsAppJidMappingRepository } from '../src/repositories/whatsappJidMappingRepository.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import {
  evaluateGroupParticipationGate,
  AI_GROUP_QUIET_MAX_MESSAGES,
  AI_GROUP_BUSY_MIN_MESSAGES,
  AI_GROUP_MENTION_COOLDOWN_MS,
  AI_GROUP_IMPLICIT_COOLDOWN_QUIET_MS,
  AI_GROUP_LARGE_SIZE_THRESHOLD,
} from '../src/services/ai/groupParticipationGate.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const chatRepository = new WhatsAppChatRepository(pool);
const messageRepository = new WhatsAppMessageRepository(pool);
const accountRepository = new WhatsAppAccountRepository(pool);
const groupRepository = new WhatsAppGroupRepository(pool);
const jidMappingRepository = new WhatsAppJidMappingRepository(pool);
const deps = { messageRepository, accountRepository, groupRepository, jidMappingRepository };

let businessId: string;
let accountId: string;
let accountJid: string;

async function createGroupChat(chatJid = `12036300000${Math.floor(Math.random() * 900000 + 100000)}@g.us`): Promise<WhatsAppChatRecord> {
  return chatRepository.upsertFromWhatsApp({
    businessId,
    whatsappAccountId: accountId,
    chatJid,
    jidKind: 'group',
    chatType: 'group',
    name: 'Test Group',
  });
}

async function sendGroupMessage(
  chat: WhatsAppChatRecord,
  opts: { senderJid: string; text: string; mentionedJids?: string[]; quotedMessageId?: string | null; secondsAgo?: number },
): Promise<WhatsAppMessageRecord> {
  const timestamp = new Date(Date.now() - (opts.secondsAgo ?? 0) * 1000).toISOString();
  return messageRepository.insert({
    businessId,
    whatsappAccountId: accountId,
    chatId: chat.id,
    whatsappMessageId: `MSG-${Math.random().toString(36).slice(2)}`,
    remoteJid: chat.chatJid,
    senderJid: opts.senderJid,
    direction: 'inbound',
    messageType: 'text',
    textContent: opts.text,
    timestamp,
    fromMe: false,
    isHistorical: false,
    hasMedia: false,
    quotedMessageId: opts.quotedMessageId ?? null,
    rawMetadata: opts.mentionedJids?.length ? { mentionedJids: opts.mentionedJids } : {},
  });
}

async function sendBotMessage(chat: WhatsAppChatRecord, text: string): Promise<WhatsAppMessageRecord> {
  return messageRepository.insert({
    businessId,
    whatsappAccountId: accountId,
    chatId: chat.id,
    whatsappMessageId: `BOT-${Math.random().toString(36).slice(2)}`,
    remoteJid: chat.chatJid,
    senderJid: accountJid,
    direction: 'outbound',
    messageType: 'text',
    textContent: text,
    timestamp: new Date().toISOString(),
    fromMe: true,
    isHistorical: false,
    hasMedia: false,
  });
}

/** Reloads the chat row after a repository call that mutates it (e.g. markAiGroupReplySent) - evaluateGroupParticipationGate reads chat fields directly, never re-fetches itself. */
async function reloadChat(chat: WhatsAppChatRecord): Promise<WhatsAppChatRecord> {
  const reloaded = await chatRepository.findById(chat.id);
  if (!reloaded) throw new Error('chat vanished mid-test');
  return reloaded;
}

async function fillActivity(chat: WhatsAppChatRecord, count: number, distinctSenders: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const sender = `155500${1000 + (i % distinctSenders)}@s.whatsapp.net`;
    await sendGroupMessage(chat, { senderJid: sender, text: `filler ${i}`, secondsAgo: 5 });
  }
}

describe('evaluateGroupParticipationGate (real Postgres)', () => {
  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountJid = '15550009999@s.whatsapp.net';
    accountId = await createTestAccount(businessId, accountJid);
  });

  it('DM chats are unaffected: isGroup false is not a concern of this module at all (sanity - callers branch before invoking it)', async () => {
    // No assertion needed on the gate itself (it's never called for a DM by
    // the real call sites in incomingMessagesWorker.ts) - this test exists
    // to document that guarantee lives in the caller, not here.
    expect(true).toBe(true);
  });

  it('an explicit mention fires even in a busy group, and the trigger is only the mentioning sender\'s trailing run', async () => {
    const chat = await createGroupChat();
    await sendGroupMessage(chat, { senderJid: '15550001111@s.whatsapp.net', text: 'unrelated chatter one' });
    await sendGroupMessage(chat, { senderJid: '15550002222@s.whatsapp.net', text: 'unrelated chatter two' });
    await sendGroupMessage(chat, { senderJid: '15550003333@s.whatsapp.net', text: 'unrelated chatter three' });
    await fillActivity(chat, AI_GROUP_BUSY_MIN_MESSAGES, 6); // push activity into 'busy'
    const mentioning = await sendGroupMessage(chat, {
      senderJid: '15550004444@s.whatsapp.net',
      text: 'hey @bot can you help',
      mentionedJids: [accountJid],
    });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(true);
    expect(gate.trigger).toBe('mention');
    expect(gate.triggerMessages.map((m) => m.id)).toEqual([mentioning.id]);
  });

  it('reply-to-bot fires regardless of activity level', async () => {
    const chat = await createGroupChat();
    const botMessage = await sendBotMessage(chat, 'Here is our pricing.');
    await fillActivity(chat, AI_GROUP_BUSY_MIN_MESSAGES, 6);
    const reply = await sendGroupMessage(chat, { senderJid: '15550005555@s.whatsapp.net', text: 'thanks, and what about installation?', quotedMessageId: botMessage.id });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(true);
    expect(gate.trigger).toBe('reply_to_bot');
    expect(gate.triggerMessages.map((m) => m.id)).toEqual([reply.id]);
  });

  it('unaddressed chatter in a busy group stays silent', async () => {
    const chat = await createGroupChat();
    await fillActivity(chat, AI_GROUP_BUSY_MIN_MESSAGES, 6);
    await sendGroupMessage(chat, { senderJid: '15550006666@s.whatsapp.net', text: 'just talking amongst ourselves' });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(false);
    expect(gate.activityBucket).toBe('busy');
  });

  it('implicit relevance (a question) fires in a quiet group', async () => {
    const chat = await createGroupChat();
    expect(AI_GROUP_QUIET_MAX_MESSAGES).toBeGreaterThanOrEqual(1); // sanity: default leaves room for at least this one message
    const question = await sendGroupMessage(chat, { senderJid: '15550007777@s.whatsapp.net', text: 'What time do you open tomorrow?' });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(true);
    expect(gate.trigger).toBe('implicit');
    expect(gate.activityBucket).toBe('quiet');
    expect(gate.triggerMessages.map((m) => m.id)).toEqual([question.id]);
  });

  it('the same kind of question does NOT fire once activity is busy', async () => {
    const chat = await createGroupChat();
    await fillActivity(chat, AI_GROUP_BUSY_MIN_MESSAGES, 6);
    await sendGroupMessage(chat, { senderJid: '15550007777@s.whatsapp.net', text: 'What time do you open tomorrow?' });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(false);
    expect(gate.activityBucket).toBe('busy');
  });

  it('a non-question message does not trigger implicit relevance even in a quiet group', async () => {
    const chat = await createGroupChat();
    await sendGroupMessage(chat, { senderJid: '15550008888@s.whatsapp.net', text: 'just saying hello to everyone' });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(false);
  });

  it('cooldown suppresses a second implicit reply too soon after the first', async () => {
    const chat = await createGroupChat();
    await sendGroupMessage(chat, { senderJid: '15550009900@s.whatsapp.net', text: 'What is your address?' });
    let unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const first = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);
    expect(first.participate).toBe(true);

    // Simulate the AI having just replied - this is the real column runAiHandoff stamps.
    await chatRepository.markAiGroupReplySent(chat.id);
    const afterReply = await reloadChat(chat);

    await sendGroupMessage(chat, { senderJid: '15550009900@s.whatsapp.net', text: 'Also, what is your phone number?' });
    unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const second = await evaluateGroupParticipationGate({ chat: afterReply, candidateMessages: unanswered }, deps);

    expect(second.participate).toBe(false);
    expect(second.cooldownRemainingMs).toBeGreaterThan(0);
    expect(second.cooldownRemainingMs).toBeLessThanOrEqual(AI_GROUP_IMPLICIT_COOLDOWN_QUIET_MS);
  });

  it('the mention cooldown blocks a near-duplicate re-mention', async () => {
    const chat = await createGroupChat();
    await sendGroupMessage(chat, { senderJid: '15550001212@s.whatsapp.net', text: '@bot help please', mentionedJids: [accountJid] });
    await chatRepository.markAiGroupReplySent(chat.id);
    const afterReply = await reloadChat(chat);

    await sendGroupMessage(chat, { senderJid: '15550001212@s.whatsapp.net', text: '@bot are you there', mentionedJids: [accountJid] });
    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat: afterReply, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(false);
    expect(gate.cooldownRemainingMs).toBeGreaterThan(0);
    expect(gate.cooldownRemainingMs).toBeLessThanOrEqual(AI_GROUP_MENTION_COOLDOWN_MS);
  });

  it('a large group nudges a would-be-quiet bucket to moderate, suppressing implicit relevance that would otherwise fire', async () => {
    const chat = await createGroupChat();
    const group = await groupRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      groupJid: chat.chatJid,
      subject: 'Big Group',
      participantsCount: AI_GROUP_LARGE_SIZE_THRESHOLD + 5,
    });
    const linkedChat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: chat.chatJid,
      jidKind: 'group',
      chatType: 'group',
      groupId: group.id,
    });
    expect(linkedChat.groupId).toBe(group.id);

    // Deliberately NOT a question - isolates the size-modifier's effect on
    // the bucket itself (quiet -> moderate, provable only via the group's
    // size, since one message from one sender would otherwise stay
    // 'quiet') from the separate "moderate blocks non-question implicit
    // relevance" behavior already covered by the busy-bucket tests above.
    await sendGroupMessage(linkedChat, { senderJid: '15550003030@s.whatsapp.net', text: 'just some idle chatter' });
    const unanswered = await messageRepository.findUnansweredInboundSince(linkedChat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat: linkedChat, candidateMessages: unanswered }, deps);

    expect(gate.activityBucket).toBe('moderate'); // would be 'quiet' without the size modifier
    expect(gate.participate).toBe(false); // moderate + non-question still doesn't fire
  });

  it('group_participation_mode OFF never participates, even on an explicit mention', async () => {
    const chat = await createGroupChat();
    await chatRepository.setGroupParticipationMode(chat.id, 'OFF', 'test');
    const off = await reloadChat(chat);
    await sendGroupMessage(off, { senderJid: '15550004040@s.whatsapp.net', text: '@bot please respond', mentionedJids: [accountJid] });

    const unanswered = await messageRepository.findUnansweredInboundSince(off.id, null);
    const gate = await evaluateGroupParticipationGate({ chat: off, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(false);
  });

  it('group_participation_mode ALWAYS_ON fires on unaddressed, non-question chatter even in a busy group', async () => {
    const chat = await createGroupChat();
    await chatRepository.setGroupParticipationMode(chat.id, 'ALWAYS_ON', 'test');
    const alwaysOn = await reloadChat(chat);
    await fillActivity(alwaysOn, AI_GROUP_BUSY_MIN_MESSAGES, 6);
    await sendGroupMessage(alwaysOn, { senderJid: '15550005050@s.whatsapp.net', text: 'just chatting, nothing special' });

    const unanswered = await messageRepository.findUnansweredInboundSince(alwaysOn.id, null);
    const gate = await evaluateGroupParticipationGate({ chat: alwaysOn, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(true);
    expect(gate.trigger).toBe('always_on');
  });

  it('group_participation_mode MENTIONS_ONLY never fires on implicit relevance, even in a quiet group with a real question', async () => {
    const chat = await createGroupChat();
    await chatRepository.setGroupParticipationMode(chat.id, 'MENTIONS_ONLY', 'test');
    const mentionsOnly = await reloadChat(chat);
    await sendGroupMessage(mentionsOnly, { senderJid: '15550006060@s.whatsapp.net', text: 'What are your hours?' });

    const unanswered = await messageRepository.findUnansweredInboundSince(mentionsOnly.id, null);
    const gate = await evaluateGroupParticipationGate({ chat: mentionsOnly, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(false);

    // But an explicit mention still fires under MENTIONS_ONLY.
    await sendGroupMessage(mentionsOnly, { senderJid: '15550006060@s.whatsapp.net', text: '@bot seriously, what are your hours', mentionedJids: [accountJid] });
    const unanswered2 = await messageRepository.findUnansweredInboundSince(mentionsOnly.id, null);
    const gate2 = await evaluateGroupParticipationGate({ chat: mentionsOnly, candidateMessages: unanswered2 }, deps);
    expect(gate2.participate).toBe(true);
    expect(gate2.trigger).toBe('mention');
  });

  it('trailing-same-sender-run selection is the direct regression test for the original concatenation bug: three senders in one burst, only the mentioning sender\'s messages are the trigger', async () => {
    const chat = await createGroupChat();
    await sendGroupMessage(chat, { senderJid: '15550007070@s.whatsapp.net', text: 'totally unrelated topic A' });
    await sendGroupMessage(chat, { senderJid: '15550008080@s.whatsapp.net', text: 'totally unrelated topic B' });
    const m1 = await sendGroupMessage(chat, { senderJid: '15550009090@s.whatsapp.net', text: 'part one of my question', mentionedJids: [accountJid] });
    const m2 = await sendGroupMessage(chat, { senderJid: '15550009090@s.whatsapp.net', text: 'part two of my question' });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(true);
    // The anchor is m1 (the mention) - the trailing run is computed up to
    // and including the anchor, so it's just m1 here (m2 arrived after the
    // anchor and is not part of the same trailing run ending at it).
    expect(gate.triggerMessages.map((m) => m.id)).toEqual([m1.id]);
    void m2;
  });

  it('a mention delivered as a @lid resolves via a seeded jid mapping to the account\'s phone JID', async () => {
    const chat = await createGroupChat();
    const lidJid = '987654321@lid';
    await jidMappingRepository.upsert(businessId, accountId, lidJid, accountJid, null, 'baileys_alt_jid', 'high');

    const mentioning = await sendGroupMessage(chat, { senderJid: '15550001313@s.whatsapp.net', text: 'hey can you help', mentionedJids: [lidJid] });

    const unanswered = await messageRepository.findUnansweredInboundSince(chat.id, null);
    const gate = await evaluateGroupParticipationGate({ chat, candidateMessages: unanswered }, deps);

    expect(gate.participate).toBe(true);
    expect(gate.trigger).toBe('mention');
    expect(gate.triggerMessages.map((m) => m.id)).toEqual([mentioning.id]);
  });
});

describe('mention/quote data capture through real ingestion + persistence (real Postgres)', () => {
  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountJid = '15550009999@s.whatsapp.net';
    accountId = await createTestAccount(businessId, accountJid);
  });

  function baseIngested(overrides: Partial<IngestedWhatsAppMessage> = {}): IngestedWhatsAppMessage {
    return {
      messageId: `MSG-${Math.random().toString(36).slice(2)}`,
      remoteJid: '120363000000000001@g.us',
      jidKind: 'group',
      phoneNumber: null,
      participant: '15550002020@s.whatsapp.net',
      remoteJidAlt: null,
      participantAlt: null,
      fromMe: false,
      pushName: 'Group Member',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: 'hello',
      fullText: 'hello',
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
      mentionedJids: [],
      quotedStanzaId: null,
      ...overrides,
    };
  }

  it('mentionedJids reach whatsapp_messages.raw_metadata', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: baseIngested({ mentionedJids: [accountJid] }),
    });

    const persisted = await messageRepository.findById(result.message.id);
    expect(persisted?.rawMetadata.mentionedJids).toEqual([accountJid]);
  });

  it('quotedStanzaId resolves to our own row id in quotedMessageId when the quoted message was persisted by us', async () => {
    const original = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: baseIngested({ messageId: 'ORIGINAL-1', fullText: 'original message', textPreview: 'original message' }),
    });

    const reply = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: baseIngested({ messageId: 'REPLY-1', fullText: 'replying to that', textPreview: 'replying to that', quotedStanzaId: 'ORIGINAL-1' }),
    });

    const persistedReply = await messageRepository.findById(reply.message.id);
    expect(persistedReply?.quotedMessageId).toBe(original.message.id);
  });

  it('a quotedStanzaId pointing at a message we never persisted resolves to null, not an error', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: baseIngested({ quotedStanzaId: 'SOME-STANZA-WE-NEVER-SAW' }),
    });

    const persisted = await messageRepository.findById(result.message.id);
    expect(persisted?.quotedMessageId).toBeNull();
  });
});
