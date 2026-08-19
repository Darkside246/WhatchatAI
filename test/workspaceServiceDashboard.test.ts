import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppCallRepository } from '../src/repositories/whatsappCallRepository.js';
import { WhatsAppOutboundMessageRepository } from '../src/repositories/whatsappOutboundMessageRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('workspaceService.getDashboardOverview (real aggregates, never a separately-maintained rollup)', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  const toJid = '15550009999@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: toJid,
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  it('reports zero real activity honestly rather than fabricating any', async () => {
    const dashboard = await workspaceService.getDashboardOverview(businessId, accountId);
    expect(dashboard.messages).toEqual({ inbound: 0, outbound: 0 });
    expect(dashboard.chats.total).toBe(1); // the chat itself exists, but has no messages
    expect(dashboard.calls).toEqual({});
    expect(dashboard.outboundReplies).toEqual({ human: 0, ai: 0 });
  });

  it('counts real inbound/outbound messages within the period', async () => {
    const messageRepo = new WhatsAppMessageRepository(pool);
    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'DASH-IN-1',
      remoteJid: toJid,
      senderJid: toJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'hello',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'DASH-OUT-1',
      remoteJid: toJid,
      senderJid: toJid,
      direction: 'outbound',
      messageType: 'text',
      textContent: 'hi there',
      timestamp: new Date().toISOString(),
      fromMe: true,
      isHistorical: false,
    });

    const dashboard = await workspaceService.getDashboardOverview(businessId, accountId);
    expect(dashboard.messages).toEqual({ inbound: 1, outbound: 1 });
  });

  it('excludes messages outside the requested period', async () => {
    const messageRepo = new WhatsAppMessageRepository(pool);
    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'DASH-OLD-1',
      remoteJid: toJid,
      senderJid: toJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'old message',
      timestamp: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      fromMe: false,
      isHistorical: true,
    });

    const dashboard = await workspaceService.getDashboardOverview(businessId, accountId, 30);
    expect(dashboard.messages.inbound).toBe(0);
  });

  it('counts real calls grouped by their real status', async () => {
    const callRepo = new WhatsAppCallRepository(pool);
    await callRepo.upsertEvent({
      businessId,
      whatsappAccountId: accountId,
      callId: 'DASH-CALL-1',
      remoteJid: toJid,
      remotePhoneNumber: '+15550009999',
      callType: 'voice',
      direction: 'inbound',
      status: 'missed',
      isVideo: false,
      isGroup: false,
      startedAt: new Date().toISOString(),
    });

    const dashboard = await workspaceService.getDashboardOverview(businessId, accountId);
    expect(dashboard.calls.missed).toBe(1);
  });

  it('counts real successfully-sent outbound messages by requester, never counting failed/queued sends', async () => {
    const outboundRepo = new WhatsAppOutboundMessageRepository(pool);
    const aiSend = await outboundRepo.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'dash-ai-1',
      messageType: 'text',
      textContent: 'AI reply',
      requestedBy: 'ai',
    });
    await outboundRepo.markSending(aiSend.id);
    await outboundRepo.markSent(aiSend.id, 'DASH-AI-WA-1');

    const humanSend = await outboundRepo.createIdempotent({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      toJid,
      idempotencyKey: 'dash-human-1',
      messageType: 'text',
      textContent: 'Human reply',
    });
    await outboundRepo.markSending(humanSend.id);
    // Never marked sent - a failed/still-queued send must never count as a real sent reply.
    await outboundRepo.markFailed(humanSend.id, 'socket disconnected');

    const dashboard = await workspaceService.getDashboardOverview(businessId, accountId);
    expect(dashboard.outboundReplies).toEqual({ human: 0, ai: 1 });
  });

  it('never leaks another business\' activity into this business\' dashboard', async () => {
    const messageRepo = new WhatsAppMessageRepository(pool);
    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'DASH-ISOLATED-1',
      remoteJid: toJid,
      senderJid: toJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'hello',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });

    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAccountId = await createTestAccount(otherBusinessId, '15550001234@s.whatsapp.net');

    const otherDashboard = await workspaceService.getDashboardOverview(otherBusinessId, otherAccountId);
    expect(otherDashboard.messages).toEqual({ inbound: 0, outbound: 0 });
  });
});
