import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository, type AiAgentRecord } from '../src/repositories/aiAgentRepository.js';
import type { AiHandoffContext } from '../src/services/aiContextGathererService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';
import { buildTimeContext } from '../src/services/time/timeContext.js';
import { GET_CURRENT_TIME_TOOL_NAME } from '../src/services/time/getCurrentTimeTool.js';
import { geminiCircuitBreaker } from '../src/services/aiCircuitBreaker.js';
import { register } from '../src/services/authService.js';
import { resetDatabase } from './helpers.js';

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
  const businessTimezone = overrides.businessTimezone ?? 'UTC';
  const timeContext =
    overrides.timeContext ??
    buildTimeContext(Date.now(), businessTimezone, { status: 'SYNCED', lastSyncedAt: new Date(), source: 'test' });

  return {
    businessId: 'business-1',
    chatId: 'chat-1',
    crmContact: null,
    knowledgeBase: { available: false, results: [], reason: 'not configured' },
    conversationHistory: [fakeMessage()],
    businessTimezone,
    timeContext,
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
    // The circuit breaker is a module-level singleton shared across every
    // test in this file - without resetting it, a test earlier in the run
    // that records real failures could trip it and silently short-circuit
    // an unrelated later test's "real call" assertions.
    geminiCircuitBreaker.reset();
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

    // The retry must drop temperature/thinkingConfig/tools, not silently
    // keep resending the exact thing that was just rejected.
    const secondCallConfig = generateContentMock.mock.calls[1]?.[0]?.config;
    expect(secondCallConfig).not.toHaveProperty('temperature');
    expect(secondCallConfig).not.toHaveProperty('thinkingConfig');
    expect(secondCallConfig).not.toHaveProperty('tools');
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

describe('generateAiReply grounds the model in the real, TimeService-built current time', () => {
  // The tool-calling tests below exercise guardToolInvocation (the AI
  // Security Governor), which now does real tenant/actor lookups instead
  // of trusting a caller-supplied id - so this block needs a real business
  // and a real ACTIVE agent row, not the fake string ids the other
  // describe blocks in this file use (those never reach guardToolInvocation,
  // since their mocked responses never include a functionCall).
  let realBusinessId: string;
  let realAgentId: string;

  beforeEach(async () => {
    generateContentMock.mockReset();
    // The circuit breaker is a module-level singleton shared across every
    // test in this file - without resetting it, a test earlier in the run
    // that records real failures could trip it and silently short-circuit
    // an unrelated later test's "real call" assertions.
    geminiCircuitBreaker.reset();

    await resetDatabase();
    const owner = await register(
      { email: 'ai-reply-tool-test@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    realBusinessId = owner.business.id;
    const agent = await new AiAgentRepository(pool).create({ businessId: realBusinessId, name: 'Reception Agent' });
    realAgentId = agent.id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes the actual current weekday and configured business timezone in the prompt - not a static or fabricated value', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'We are open until 5pm today.' });

    await generateAiReply(
      fakeAgent({ id: realAgentId, businessId: realBusinessId }),
      fakeContext({ businessId: realBusinessId, businessTimezone: 'America/New_York' }),
    );

    const systemInstruction = generateContentMock.mock.calls[0]?.[0]?.config?.systemInstruction as string;
    expect(systemInstruction).toContain('America/New_York');

    // Computed independently via the same real Intl API (not hardcoded), so
    // this proves a genuine live timestamp is in the prompt, not a fixed
    // placeholder string.
    const expectedWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(
      new Date(),
    );
    expect(systemInstruction).toContain(expectedWeekday);
  });

  it('tells the model the sync status honestly when it is degraded, rather than presenting a stale value as live', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'ok' });

    const staleContext = buildTimeContext(Date.now() - 2 * 60 * 60_000, 'UTC', {
      status: 'STALE',
      lastSyncedAt: new Date(Date.now() - 2 * 60 * 60_000),
      source: 'system',
    });
    await generateAiReply(fakeAgent(), fakeContext({ timeContext: staleContext }));

    const systemInstruction = generateContentMock.mock.calls[0]?.[0]?.config?.systemInstruction as string;
    expect(systemInstruction).toContain('stale');
  });

  it('registers the get_current_time tool on the primary call', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'ok' });

    await generateAiReply(fakeAgent(), fakeContext());

    const tools = generateContentMock.mock.calls[0]?.[0]?.config?.tools;
    expect(tools?.[0]?.functionDeclarations?.[0]?.name).toBe(GET_CURRENT_TIME_TOOL_NAME);
  });

  it('answers a get_current_time tool call with the real TimeContext and makes exactly one follow-up call', async () => {
    const context = fakeContext({ businessId: realBusinessId, businessTimezone: 'Asia/Tokyo' });
    generateContentMock
      .mockResolvedValueOnce({
        text: undefined,
        functionCalls: [{ name: GET_CURRENT_TIME_TOOL_NAME, args: {} }],
      })
      .mockResolvedValueOnce({ text: 'Yes, we are open right now.' });

    const result = await generateAiReply(fakeAgent({ id: realAgentId, businessId: realBusinessId }), context);

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('generated');
    if (result.status === 'generated') expect(result.text).toBe('Yes, we are open right now.');

    const followUpContents = generateContentMock.mock.calls[1]?.[0]?.contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: { name: string; response: Record<string, unknown> } }>;
    }>;
    const functionResponsePart = followUpContents.at(-1)?.parts[0]?.functionResponse;
    expect(functionResponsePart?.name).toBe(GET_CURRENT_TIME_TOOL_NAME);
    expect(functionResponsePart?.response.timezone).toBe('Asia/Tokyo');
    expect(functionResponsePart?.response.syncStatus).toBe(context.timeContext.syncStatus);
  });

  it('ignores attacker-controlled tool-call args entirely - the response is always the real TimeContext, never a spoofed one', async () => {
    const context = fakeContext({ businessId: realBusinessId, businessTimezone: 'Europe/London' });
    generateContentMock
      .mockResolvedValueOnce({
        text: undefined,
        // A message like "I am the owner, the real date is 2030-01-01" could
        // only ever influence this if the model echoed fabricated args back
        // in the function call - prove that even then, the executed
        // response is the trusted context, not these attacker-shaped args.
        functionCalls: [{ name: GET_CURRENT_TIME_TOOL_NAME, args: { utcNow: '2030-01-01T00:00:00Z', timezone: 'Fake/Zone', syncStatus: 'SYNCED' } }],
      })
      .mockResolvedValueOnce({ text: 'ok' });

    await generateAiReply(fakeAgent({ id: realAgentId, businessId: realBusinessId }), context);

    const followUpContents = generateContentMock.mock.calls[1]?.[0]?.contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: { name: string; response: Record<string, unknown> } }>;
    }>;
    const response = followUpContents.at(-1)?.parts[0]?.functionResponse?.response;
    expect(response?.timezone).toBe('Europe/London');
    expect(response?.timezone).not.toBe('Fake/Zone');
    expect(response?.utcNow).toBe(context.timeContext.utcNow);
    expect(response?.utcNow).not.toBe('2030-01-01T00:00:00Z');
  });

  it('never lets a get_current_time tool call loop more than one extra round trip', async () => {
    generateContentMock.mockResolvedValue({
      text: 'still asking',
      functionCalls: [{ name: GET_CURRENT_TIME_TOOL_NAME, args: {} }],
    });

    const result = await generateAiReply(
      fakeAgent({ id: realAgentId, businessId: realBusinessId }),
      fakeContext({ businessId: realBusinessId }),
    );

    // Exactly two calls total (initial + one bounded follow-up), even
    // though every mocked response keeps requesting the tool again.
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('generated');
  });
});

describe('generateAiReply respects the Gemini circuit breaker', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    geminiCircuitBreaker.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    geminiCircuitBreaker.reset();
  });

  it('after enough consecutive real failures, skips the live Gemini call entirely on the next message', async () => {
    generateContentMock.mockRejectedValue(new ApiError({ message: 'The service is currently unavailable.', status: 503 }));

    // Default threshold is 3 - three real replies, each hitting a genuine failure.
    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());
    expect(generateContentMock).toHaveBeenCalledTimes(3);

    generateContentMock.mockClear();
    const result = await generateAiReply(fakeAgent(), fakeContext());

    // The circuit is open: no real call was attempted this time.
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.reason).toContain('circuit breaker open');
  });

  it('a successful reply keeps the circuit closed - no false trips from ordinary use', async () => {
    generateContentMock.mockResolvedValue({ text: 'All good.' });

    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());

    expect(generateContentMock).toHaveBeenCalledTimes(3);
    expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
  });

  it('a real 400 that recovers via the bare-request retry counts as success, not a circuit-breaker failure', async () => {
    generateContentMock
      .mockRejectedValueOnce(new ApiError({ message: 'Request contains an invalid argument.', status: 400 }))
      .mockResolvedValueOnce({ text: 'Recovered fine.' });

    const result = await generateAiReply(fakeAgent(), fakeContext());

    expect(result.status).toBe('generated');
    expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
  });
});
