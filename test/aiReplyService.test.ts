import { describe, expect, it } from 'vitest';
import { generateAiReply } from '../src/services/aiReplyService.js';
import type { AiAgentRecord } from '../src/repositories/aiAgentRepository.js';
import type { AiHandoffContext } from '../src/services/aiContextGathererService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';
import { buildTimeContext } from '../src/services/time/timeContext.js';

function fakeAgent(overrides: Partial<AiAgentRecord> = {}): AiAgentRecord {
  return {
    id: 'agent-1',
    businessId: 'business-1',
    name: 'Reception Agent',
    description: null,
    persona: 'Friendly and concise',
    tone: 'warm',
    language: 'English',
    systemInstruction: 'Help qualify inbound leads.',
    greeting: null,
    businessContext: null,
    responseStyle: null,
    humanTakeoverPolicy: null,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

function fakeMessage(overrides: Partial<WhatsAppMessageRecord> = {}): WhatsAppMessageRecord {
  return {
    id: 'message-1',
    businessId: 'business-1',
    whatsappAccountId: 'account-1',
    chatId: 'chat-1',
    whatsappMessageId: 'WA-1',
    remoteJid: '15550009999@s.whatsapp.net',
    senderJid: '15550009999@s.whatsapp.net',
    recipientJid: null,
    senderContactId: null,
    direction: 'inbound',
    messageType: 'text',
    textContent: 'What are your opening hours?',
    caption: null,
    timestamp: new Date().toISOString(),
    fromMe: false,
    isHistorical: false,
    status: 'delivered',
    hasMedia: false,
    mediaId: null,
    rawMetadata: {},
    createdAt: new Date().toISOString(),
    wasInserted: true,
    ...overrides,
  };
}

function fakeContext(overrides: Partial<AiHandoffContext> = {}): AiHandoffContext {
  return {
    businessId: 'business-1',
    chatId: 'chat-1',
    crmContact: null,
    knowledgeBase: { available: false, results: [], reason: 'not configured' },
    conversationHistory: [fakeMessage()],
    businessTimezone: 'UTC',
    timeContext: buildTimeContext(Date.now(), 'UTC', { status: 'SYNCED', lastSyncedAt: new Date(), source: 'test' }),
    ...overrides,
  };
}

describe('generateAiReply (real GEMINI_API_KEY state in this environment - never fabricates a reply)', () => {
  it('fails safe with an honest "unavailable" result when GEMINI_API_KEY is not configured', async () => {
    const result = await generateAiReply(fakeAgent(), fakeContext());

    if (!process.env.GEMINI_API_KEY) {
      expect(result.status).toBe('unavailable');
      if (result.status === 'unavailable') {
        expect(result.reason).toContain('GEMINI_API_KEY');
      }
    } else {
      expect(['generated', 'unavailable']).toContain(result.status);
    }
  });

  it('reports "unavailable" rather than calling the model when there is no real text to reply to', async () => {
    const result = await generateAiReply(
      fakeAgent(),
      fakeContext({ conversationHistory: [fakeMessage({ textContent: null, messageType: 'image', hasMedia: true })] }),
    );

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('No real message text');
    }
  });
});
