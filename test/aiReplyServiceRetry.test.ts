import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import type { AiAgentRecord } from '../src/repositories/aiAgentRepository.js';
import type { AiHandoffContext } from '../src/services/aiContextGathererService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';

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
  } as AiAgentRecord;
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
  } as WhatsAppMessageRecord;
}

function fakeContext(overrides: Partial<AiHandoffContext> = {}): AiHandoffContext {
  return {
    crmContact: null,
    knowledgeBase: { available: false, results: [], reason: 'not configured' },
    conversationHistory: [fakeMessage()],
    businessTimezone: 'UTC',
    ...overrides,
  };
}

const generateContentMock = vi.fn();

vi.mock('../src/services/geminiClient.js', () => ({
  getGeminiClient: () => ({ models: { generateContent: (...args: unknown[]) => generateContentMock(...args) } }),
}));

const { generateAiReply } = await import('../src/services/aiReplyService.js');

/**
 * Reproduces the real reported failure: a live deployment's Gemini call
 * rejected with a real 400 INVALID_ARGUMENT on the exact
 * temperature+thinkingConfig shape this service sends (confirmed via the
 * "Test Gemini connection" diagnostic against a real key). These tests prove
 * the fallback actually recovers a reply instead of just logging the same
 * failure forever, and that it stays out of the way for anything else.
 */
describe('generateAiReply retries with a bare request after a real 400 INVALID_ARGUMENT', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('recovers a real reply when the full config is rejected but a bare request works', async () => {
    generateContentMock
      .mockRejectedValueOnce(new ApiError({ message: 'Request contains an invalid argument.', status: 400 }))
      .mockResolvedValueOnce({ text: 'We are open Monday to Friday, 9am to 5pm.' });

    const result = await generateAiReply(fakeAgent(), fakeContext());

    expect(result.status).toBe('generated');
    if (result.status === 'generated') expect(result.text).toBe('We are open Monday to Friday, 9am to 5pm.');
    expect(generateContentMock).toHaveBeenCalledTimes(2);

    // The retry must drop temperature/thinkingConfig, not silently keep
    // resending the exact thing that was just rejected.
    const secondCallConfig = generateContentMock.mock.calls[1]?.[0]?.config;
    expect(secondCallConfig).not.toHaveProperty('temperature');
    expect(secondCallConfig).not.toHaveProperty('thinkingConfig');
    expect(secondCallConfig?.systemInstruction).toBeTruthy();
  });

  it('does not retry on a non-400 error - falls through to Goose/unavailable honestly instead of masking a different failure', async () => {
    generateContentMock.mockRejectedValueOnce(new ApiError({ message: 'The service is currently unavailable.', status: 503 }));

    const result = await generateAiReply(fakeAgent(), fakeContext());

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.reason).toContain('The service is currently unavailable.');
  });

  it('falls back honestly when even the bare retry fails - never fabricates a reply', async () => {
    generateContentMock
      .mockRejectedValueOnce(new ApiError({ message: 'Request contains an invalid argument.', status: 400 }))
      .mockRejectedValueOnce(new ApiError({ message: 'Model not found.', status: 404 }));

    const result = await generateAiReply(fakeAgent(), fakeContext());

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('unavailable');
  });
});

describe('generateAiReply grounds the model in the real current time', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes the actual current weekday and the configured business timezone in the prompt - not a static or fabricated value', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'We are open until 5pm today.' });

    await generateAiReply(fakeAgent(), fakeContext({ businessTimezone: 'America/New_York' }));

    const systemInstruction = generateContentMock.mock.calls[0]?.[0]?.config?.systemInstruction as string;
    expect(systemInstruction).toContain('business timezone: America/New_York');

    // Computed independently via the same real Intl API (not hardcoded),
    // so this proves a genuine live timestamp is in the prompt, not a
    // fixed placeholder string.
    const expectedWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(
      new Date(),
    );
    expect(systemInstruction).toContain(expectedWeekday);
  });

  it('falls back to a labeled UTC time rather than crashing when the stored timezone is invalid', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'ok' });

    await generateAiReply(fakeAgent(), fakeContext({ businessTimezone: 'Not/ARealTimezone' }));

    const systemInstruction = generateContentMock.mock.calls[0]?.[0]?.config?.systemInstruction as string;
    expect(systemInstruction).toContain('not recognized - showing UTC');
  });
});
