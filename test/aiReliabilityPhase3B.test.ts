import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ApiError } from '@google/genai';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { register } from '../src/services/authService.js';
import { classifyAiError } from '../src/services/ai/aiErrorClassification.js';
import { geminiCircuitBreaker, geminiConfigCircuitBreaker } from '../src/services/aiCircuitBreaker.js';
import { buildTimeContext } from '../src/services/time/timeContext.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import type { AiAgentRecord } from '../src/repositories/aiAgentRepository.js';
import type { AiHandoffContext } from '../src/services/aiContextGathererService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';

// Fast, real (within the documented 1000-30000ms bound) debounce window so
// this file's tests run quickly without bypassing the actual clamp logic -
// 1000 is the bound's own minimum, so this also incidentally proves that
// boundary value is honored. Must be set before realtimeEventsQueue.ts (a
// module-load-time env read) is ever imported below.
process.env.AI_DEBOUNCE_DELAY_MS = '1000';

// getGeminiClient() is shared by two real, independent callers: the AI
// reply pipeline (aiReplyService) AND the Tiered Security Sentinel's own
// Stage 2 AI classification (security/sentinel/aiSentinel.ts) - every real
// inbound text message goes through the Sentinel BEFORE persistence, and
// the Sentinel is explicitly out of scope for Phase 3B. Sentinel calls are
// distinguishable by their real, distinct request shape
// (responseMimeType/responseSchema, set only by aiSentinel.ts) and are
// always answered safely and automatically here, untracked - every test
// below configures/asserts against aiReplyGenerateContentMock, which only
// ever sees the AI-reply-path calls it actually cares about.
const aiReplyGenerateContentMock = vi.fn();
const generateContentMock = vi.fn(async (args: { config?: { responseSchema?: unknown } }) => {
  if (args?.config?.responseSchema) {
    return { text: JSON.stringify({ safe: true, reason: 'not a security concern' }) };
  }
  return aiReplyGenerateContentMock(args);
});
vi.mock('../src/services/geminiClient.js', () => ({
  getGeminiClient: () => ({ models: { generateContent: (...args: unknown[]) => generateContentMock(...args) } }),
}));

const notifyBusinessMock = vi.fn().mockResolvedValue([]);
vi.mock('../src/services/notificationService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/notificationService.js')>();
  return { ...actual, notifyBusiness: (...args: unknown[]) => notifyBusinessMock(...args) };
});

const { generateAiReply } = await import('../src/services/aiReplyService.js');
const { orchestrateAiReply } = await import('../src/services/ai/aiOrchestrator.js');
const { enqueueIncomingMessage, incomingMessagesQueue } = await import('../src/queue/queues/incomingMessagesQueue.js');
const { realtimeEventsQueue, AI_DEBOUNCE_DELAY_MS } = await import('../src/queue/queues/realtimeEventsQueue.js');
const { incomingMessagesWorker, realtimeEventsWorker, sweepStaleAiHandoff } = await import(
  '../src/queue/workers/incomingMessagesWorker.js'
);
const { whatsappOutboundMessageService } = await import('../src/services/whatsappOutboundMessageService.js');

function fakeAgent(overrides: Partial<AiAgentRecord> = {}): AiAgentRecord {
  return {
    id: 'agent-1',
    businessId: 'business-1',
    name: 'Reception Agent',
    description: null,
    persona: null,
    tone: null,
    language: null,
    systemInstruction: 'Help qualify inbound leads.',
    greeting: null,
    businessContext: null,
    responseStyle: null,
    humanTakeoverPolicy: null,
    category: 'general',
    specialization: null,
    triggerKeywords: [],
    blockedKeywords: [],
    responseDelaySeconds: 0,
    parentAgentId: null,
    escalateToAgentId: null,
    priority: 0,
    canvasX: null,
    canvasY: null,
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
  } as WhatsAppMessageRecord;
}

function fakeContext(overrides: Partial<AiHandoffContext> = {}): AiHandoffContext {
  return {
    businessId: 'business-1',
    chatId: 'chat-1',
    crmContact: null,
    knowledgeBase: { available: false, results: [], reason: 'not configured' },
    documentContext: { available: false, results: [], reason: 'not configured' },
    conversationHistory: [fakeMessage()],
    businessTimezone: 'UTC',
    timeContext: buildTimeContext(Date.now(), 'UTC', { status: 'SYNCED', lastSyncedAt: new Date(), source: 'test' }),
    media: null,
    ...overrides,
  };
}

/**
 * Phase 3B: docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md's five-way
 * error taxonomy, the split circuit breakers, the one-time operator
 * notification, the escalation-hop fix, the trailing-edge debounce, and
 * the outbound-send boundary fix - all authorized in the same review that
 * approved this test plan. Only Baileys/Gemini's own network calls and the
 * notification side effect are mocked; BullMQ, Postgres, and every guarded
 * repository transition stay real throughout.
 */
describe('classifyAiError - the five-way taxonomy (pure unit tests, no mocking)', () => {
  it('1a. 429/500/502/503/504 classify as capacity', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const result = classifyAiError(new ApiError({ message: `status ${status}`, status }));
      expect(result.category).toBe('capacity');
    }
  });

  it('1b. 401/403 classify as auth', () => {
    for (const status of [401, 403]) {
      const result = classifyAiError(new ApiError({ message: `status ${status}`, status }));
      expect(result.category).toBe('auth');
    }
  });

  it('1c. 400 classifies as malformed_request', () => {
    const result = classifyAiError(new ApiError({ message: 'bad request', status: 400 }));
    expect(result.category).toBe('malformed_request');
  });

  it('1d. 404 classifies as provider_config', () => {
    const result = classifyAiError(new ApiError({ message: 'model not found', status: 404 }));
    expect(result.category).toBe('provider_config');
  });

  it('1e. an unrecognized ApiError status classifies conservatively as programming, never guessed as capacity/config', () => {
    const result = classifyAiError(new ApiError({ message: 'teapot', status: 418 }));
    expect(result.category).toBe('programming');
    expect(result.message).toContain('418');
  });

  it('1f. real Node network error codes classify as capacity', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED']) {
      const error = Object.assign(new Error('network blip'), { code });
      expect(classifyAiError(error).category).toBe('capacity');
    }
  });

  it('1g. a network code nested under .cause (real Node/undici fetch-failed shape) still classifies as capacity', () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(classifyAiError(error).category).toBe('capacity');
  });

  it('1h. an AbortError (timeout) classifies as capacity', () => {
    const error = new DOMException('The operation was aborted', 'AbortError');
    expect(classifyAiError(error).category).toBe('capacity');
  });

  it('1i. a genuine bug (a plain thrown Error unrelated to any HTTP/network shape) classifies as programming', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'foo')");
    expect(classifyAiError(error).category).toBe('programming');
  });

  it('1j. a non-Error thrown value still classifies safely as programming, never throws itself', () => {
    expect(classifyAiError('a raw string throw').category).toBe('programming');
    expect(classifyAiError(undefined).category).toBe('programming');
  });
});

describe('generateAiReply - circuit-breaker separation and one-time notification gating', () => {
  beforeEach(() => {
    aiReplyGenerateContentMock.mockReset();
    notifyBusinessMock.mockClear();
    geminiCircuitBreaker.reset();
    geminiConfigCircuitBreaker.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('2a. three consecutive capacity (503) failures open the capacity breaker but never touch the config breaker', async () => {
    aiReplyGenerateContentMock.mockRejectedValue(new ApiError({ message: 'unavailable', status: 503 }));

    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());

    expect(geminiCircuitBreaker.getState()).toBe('OPEN');
    expect(geminiConfigCircuitBreaker.getState()).toBe('CLOSED');
  });

  it('2b. a single auth (401) failure opens the config breaker immediately but never touches the capacity breaker', async () => {
    aiReplyGenerateContentMock.mockRejectedValueOnce(new ApiError({ message: 'invalid key', status: 401 }));

    const result = await generateAiReply(fakeAgent(), fakeContext());

    expect(geminiConfigCircuitBreaker.getState()).toBe('OPEN');
    expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
    expect(result.status).toBe('unavailable');
  });

  it('2c. three consecutive auth failures never open the capacity breaker either - it takes a real capacity signal, not just any failure', async () => {
    aiReplyGenerateContentMock.mockRejectedValue(new ApiError({ message: 'invalid key', status: 401 }));

    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());
    await generateAiReply(fakeAgent(), fakeContext());

    expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
  });

  it('2d. a provider_config (404) failure also opens the config breaker, not the capacity breaker', async () => {
    aiReplyGenerateContentMock.mockRejectedValueOnce(new ApiError({ message: 'model not found', status: 404 }));

    await generateAiReply(fakeAgent(), fakeContext());

    expect(geminiConfigCircuitBreaker.getState()).toBe('OPEN');
    expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
  });

  it('2e. a malformed_request (400) failure that also fails the bare-request retry touches neither breaker', async () => {
    aiReplyGenerateContentMock
      .mockRejectedValueOnce(new ApiError({ message: 'bad request', status: 400 }))
      .mockRejectedValueOnce(new ApiError({ message: 'still bad', status: 400 }));

    await generateAiReply(fakeAgent(), fakeContext());

    expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
    expect(geminiConfigCircuitBreaker.getState()).toBe('CLOSED');
  });

  it('3a. a programming-class error (a plain bug, not an ApiError) fails loud, skips Goose/escalation, and touches neither breaker', async () => {
    aiReplyGenerateContentMock.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'x')"));

    const result = await generateAiReply(fakeAgent(), fakeContext());

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('Internal error, not a provider failure');
      expect(result.skipEscalation).toBe(true);
    }
    expect(geminiCircuitBreaker.getState()).toBe('CLOSED');
    expect(geminiConfigCircuitBreaker.getState()).toBe('CLOSED');
    // Called exactly once - a programming bug never gets a bare-request
    // retry (that mechanism only exists for a real 400 ApiError) and never
    // triggers a second attempt of any kind.
    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1);
  });

  it('4a. the first auth failure fires exactly one operator notification; a second failure while still open does not re-notify', async () => {
    aiReplyGenerateContentMock.mockRejectedValue(new ApiError({ message: 'invalid key', status: 401 }));

    await generateAiReply(fakeAgent({ businessId: 'business-notify-1' }), fakeContext({ businessId: 'business-notify-1' }));
    expect(notifyBusinessMock).toHaveBeenCalledTimes(1);
    expect(notifyBusinessMock.mock.calls[0]?.[0]).toMatchObject({ businessId: 'business-notify-1', type: 'AI_FAILURE' });

    await generateAiReply(fakeAgent({ businessId: 'business-notify-1' }), fakeContext({ businessId: 'business-notify-1' }));
    expect(notifyBusinessMock).toHaveBeenCalledTimes(1); // still just once - the incident is still open
  });

  it('4b. after the config breaker recovers (a real success), a new failure notifies again - a genuinely new incident', async () => {
    aiReplyGenerateContentMock
      .mockRejectedValueOnce(new ApiError({ message: 'invalid key', status: 401 }))
      .mockResolvedValueOnce({ text: 'Recovered.' })
      .mockRejectedValueOnce(new ApiError({ message: 'invalid key again', status: 401 }));

    await generateAiReply(fakeAgent(), fakeContext());
    expect(notifyBusinessMock).toHaveBeenCalledTimes(1);

    await generateAiReply(fakeAgent(), fakeContext()); // the real success - closes the config breaker
    expect(geminiConfigCircuitBreaker.getState()).toBe('CLOSED');

    await generateAiReply(fakeAgent(), fakeContext());
    expect(notifyBusinessMock).toHaveBeenCalledTimes(2);
  });

  it('4c. a failure to notify (the notifier itself throwing) never alters the reply outcome - best-effort and isolated', async () => {
    notifyBusinessMock.mockRejectedValueOnce(new Error('simulated notification service outage'));
    aiReplyGenerateContentMock.mockRejectedValueOnce(new ApiError({ message: 'invalid key', status: 401 }));

    const result = await generateAiReply(fakeAgent(), fakeContext());

    expect(result.status).toBe('unavailable'); // the real outcome, unaffected by the notifier throwing
    expect(geminiConfigCircuitBreaker.getState()).toBe('OPEN'); // the breaker state still recorded correctly
  });
});

describe('orchestrateAiReply - escalation hop is skipped for a failure class it cannot fix', () => {
  let businessId: string;
  let primaryAgentId: string;
  let escalationAgentId: string;
  let chatId: string;

  beforeEach(async () => {
    aiReplyGenerateContentMock.mockReset();
    notifyBusinessMock.mockClear();
    geminiCircuitBreaker.reset();
    geminiConfigCircuitBreaker.reset();

    await resetDatabase();
    const owner = await register(
      { email: 'escalation-test@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    const agents = new AiAgentRepository(pool);
    const escalation = await agents.create({ businessId, name: 'Escalation Agent', priority: 0 });
    escalationAgentId = escalation.id;
    // routeInboundMessage ties on priority by name ("Escalation Agent" would
    // otherwise alphabetically sort before "Primary Agent") - explicit
    // higher priority makes the intended primary agent deterministically
    // win routing, regardless of name.
    const primary = await agents.create({
      businessId,
      name: 'Primary Agent',
      priority: 10,
      escalateToAgentId: escalationAgentId,
    });
    primaryAgentId = primary.id;

    // gatherAiHandoffContext builds `contents` from a REAL listByChat query
    // (not from the queryText param) - without a real persisted inbound
    // message, `contents` is empty and generateAiReply short-circuits
    // before ever reaching a real call, regardless of the mocked outcome.
    const accountId = await createTestAccount(businessId);
    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550005555@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
    const messageRepo = new WhatsAppMessageRepository(pool);
    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: `ESCALATION-TEST-${Date.now()}`,
      remoteJid: '15550005555@s.whatsapp.net',
      senderJid: '15550005555@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'Are you open today?',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('9a. a capacity failure never invokes the escalation agent - only one real call total', async () => {
    aiReplyGenerateContentMock.mockRejectedValue(new ApiError({ message: 'unavailable', status: 503 }));

    const outcome = await orchestrateAiReply({ businessId, chatId, contactId: null, queryText: 'Are you open today?' });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') expect(outcome.agent.id).toBe(primaryAgentId); // never escalated
    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1);
    void escalationAgentId;
  });

  it('9b. an auth failure never invokes the escalation agent - the same broken key would fail identically', async () => {
    aiReplyGenerateContentMock.mockRejectedValue(new ApiError({ message: 'invalid key', status: 401 }));

    const outcome = await orchestrateAiReply({ businessId, chatId, contactId: null, queryText: 'hi' });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') expect(outcome.agent.id).toBe(primaryAgentId);
    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1);
  });

  it('9c. a malformed_request failure DOES try the escalation agent - a different agent config could plausibly avoid it', async () => {
    aiReplyGenerateContentMock
      .mockRejectedValueOnce(new ApiError({ message: 'bad request', status: 400 }))
      .mockRejectedValueOnce(new ApiError({ message: 'still bad', status: 400 })) // primary's bare-request retry also fails
      .mockResolvedValueOnce({ text: 'The escalation agent handled it fine.' });

    const outcome = await orchestrateAiReply({ businessId, chatId, contactId: null, queryText: 'hi' });

    expect(outcome.kind).toBe('reply');
    if (outcome.kind === 'reply') {
      expect(outcome.agent.id).toBe(escalationAgentId);
      expect(outcome.text).toBe('The escalation agent handled it fine.');
    }
    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(3); // primary attempt + bare retry, then escalation agent's one real call
  });
});

/**
 * Real BullMQ + real Postgres for the trailing-edge debounce mechanism
 * itself (docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 5) -
 * only the Gemini network call is mocked.
 */
describe('AI debounce - bursts, ordering, duplicate/stale jobs, crash safety, cross-tenant isolation', () => {
  const createdBusinessIds: string[] = [];

  beforeEach(async () => {
    await resetDatabase();
    aiReplyGenerateContentMock.mockReset();
    notifyBusinessMock.mockClear();
    geminiCircuitBreaker.reset();
    geminiConfigCircuitBreaker.reset();
  });

  afterAll(async () => {
    await incomingMessagesWorker.close();
    await realtimeEventsWorker.close();
    await incomingMessagesQueue.close();
    await realtimeEventsQueue.close();
    void createdBusinessIds;
  });

  async function setupBusinessWithAgent(): Promise<{ businessId: string; accountId: string; accountJid: string }> {
    const businessId = await createTestBusiness();
    const accountJid = `1555000${Math.floor(Math.random() * 9000 + 1000)}@s.whatsapp.net`;
    const accountId = await createTestAccount(businessId, accountJid);
    await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent' });
    return { businessId, accountId, accountJid };
  }

  function buildIngested(messageId: string, text: string): IngestedWhatsAppMessage {
    return {
      messageId,
      remoteJid: '15550003333@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550003333',
      participant: null,
      fromMe: false,
      pushName: 'Debounce Test Contact',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: text,
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };
  }

  async function sendAndWaitPersisted(
    businessId: string,
    accountId: string,
    accountJid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for message to persist')), 10_000);
      incomingMessagesWorker.on('completed', function onCompleted(job) {
        if (job.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('completed', onCompleted);
        resolve();
      });
    });
    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid, message: buildIngested(messageId, text) });
    await completion;
  }

  function waitForDebounceRound(businessId: string, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for AI debounce round')), timeoutMs);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'ai-debounce' || job.data.businessId !== businessId) return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });
  }

  it('5/6. a rapid 3-message burst produces exactly one combined Gemini call, with all three texts in chronological order', async () => {
    aiReplyGenerateContentMock.mockResolvedValueOnce({ text: 'Got all three, thanks!' });
    const { businessId, accountId, accountJid } = await setupBusinessWithAgent();

    const debounceRound = waitForDebounceRound(businessId, 15_000);
    await sendAndWaitPersisted(businessId, accountId, accountJid, `BURST-1-${Date.now()}`, 'hi there');
    await sendAndWaitPersisted(businessId, accountId, accountJid, `BURST-2-${Date.now()}`, 'I need help');
    await sendAndWaitPersisted(businessId, accountId, accountJid, `BURST-3-${Date.now()}`, 'with my order please');
    await debounceRound;

    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1);
    const sentContents = JSON.stringify(aiReplyGenerateContentMock.mock.calls[0]?.[0]?.contents);
    const iHi = sentContents.indexOf('hi there');
    const iHelp = sentContents.indexOf('I need help');
    const iOrder = sentContents.indexOf('with my order please');
    expect(iHi).toBeGreaterThanOrEqual(0);
    expect(iHelp).toBeGreaterThan(iHi); // real chronological order, not arrival/processing order
    expect(iOrder).toBeGreaterThan(iHelp);
  }, 20_000);

  it('6. a single, isolated message still gets a real reply - debouncing never turns into "always wait needlessly" beyond the one window', async () => {
    aiReplyGenerateContentMock.mockResolvedValueOnce({ text: 'Sure, we are open until 6pm.' });
    const { businessId, accountId, accountJid } = await setupBusinessWithAgent();

    const debounceRound = waitForDebounceRound(businessId, 15_000);
    await sendAndWaitPersisted(businessId, accountId, accountJid, `SINGLE-${Date.now()}`, 'are you open right now?');
    await debounceRound;

    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query('SELECT count(*) AS count FROM whatsapp_outbound_messages WHERE business_id = $1', [
      businessId,
    ]);
    expect(Number(rows[0].count)).toBe(1);
  }, 20_000);

  it('6b. a chat that already completed one debounce round still gets a real reply for a later, unrelated message (a finished job under the deterministic jobId must not permanently block future rounds)', async () => {
    aiReplyGenerateContentMock.mockResolvedValueOnce({ text: 'First reply' }).mockResolvedValueOnce({ text: 'Second reply' });
    const { businessId, accountId, accountJid } = await setupBusinessWithAgent();

    const firstRound = waitForDebounceRound(businessId, 15_000);
    await sendAndWaitPersisted(businessId, accountId, accountJid, `ROUND1-${Date.now()}`, 'first message');
    await firstRound;
    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1);

    // Same chat (buildIngested always targets the same remoteJid) - its
    // ai-debounce-<chatId> job is now 'completed'. Without removing that
    // stale job before re-adding, scheduleAiDebounce would silently reuse
    // it and this second round would never fire.
    const secondRound = waitForDebounceRound(businessId, 15_000);
    await sendAndWaitPersisted(businessId, accountId, accountJid, `ROUND2-${Date.now()}`, 'second message, much later');
    await secondRound;

    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('7. a duplicate/redelivered debounce attempt against a chat whose claim is already held is a safe no-op', async () => {
    const { businessId, accountId } = await setupBusinessWithAgent();
    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });

    const firstClaim = await chatRepo.claimAiHandoff(chat.id);
    expect(firstClaim).not.toBeNull();

    // A second, concurrent/redelivered attempt for the same chat finds the
    // claim already held - exactly the guard that prevents a duplicate
    // reply from a duplicate/stale debounce job delivery.
    const duplicateClaim = await chatRepo.claimAiHandoff(chat.id);
    expect(duplicateClaim).toBeNull();
  });

  it('8. crash-recovery: a stale claim (worker died mid-handoff) is released and re-armed by the sweep, producing a real reply', async () => {
    aiReplyGenerateContentMock.mockResolvedValueOnce({ text: 'Recovered after the sweep.' });
    const { businessId, accountId, accountJid } = await setupBusinessWithAgent();

    await sendAndWaitPersisted(businessId, accountId, accountJid, `CRASH-${Date.now()}`, 'anyone there?');

    // Simulate a worker that claimed the handoff and then died before
    // releasing it - the real debounce job that would have processed this
    // message is deliberately left alone (never awaited), reproducing
    // "claimed, then nothing else ever ran."
    const messageRepo = new WhatsAppMessageRepository(pool);
    const { rows: chatRows } = await pool.query<{ chat_id: string }>(
      `SELECT chat_id FROM whatsapp_messages WHERE business_id = $1 LIMIT 1`,
      [businessId],
    );
    const chatId = chatRows[0]!.chat_id;
    const chatRepo = new WhatsAppChatRepository(pool);
    await chatRepo.claimAiHandoff(chatId);
    await pool.query(`UPDATE whatsapp_chats SET ai_handoff_claimed_at = now() - interval '10 minutes' WHERE id = $1`, [
      chatId,
    ]);

    const debounceRound = waitForDebounceRound(businessId, 15_000);
    await sweepStaleAiHandoff();
    await debounceRound;

    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1);
    const chatAfter = await chatRepo.findById(chatId);
    expect(chatAfter?.aiHandoffClaimedAt).toBeNull();
    void messageRepo;
  }, 20_000);

  it('11. cross-tenant: two businesses debouncing around the same time never mix each other\'s messages into one reply', async () => {
    aiReplyGenerateContentMock.mockResolvedValueOnce({ text: 'Reply for business A.' }).mockResolvedValueOnce({ text: 'Reply for business B.' });
    const businessA = await setupBusinessWithAgent();
    const businessB = await setupBusinessWithAgent();

    const roundA = waitForDebounceRound(businessA.businessId, 15_000);
    const roundB = waitForDebounceRound(businessB.businessId, 15_000);
    await sendAndWaitPersisted(businessA.businessId, businessA.accountId, businessA.accountJid, `TENANT-A-${Date.now()}`, 'secret to business A only');
    await sendAndWaitPersisted(businessB.businessId, businessB.accountId, businessB.accountJid, `TENANT-B-${Date.now()}`, 'secret to business B only');
    await Promise.all([roundA, roundB]);

    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(2);
    const allSentText = aiReplyGenerateContentMock.mock.calls.map((call) => JSON.stringify(call[0]?.contents));
    const callWithA = allSentText.find((text) => text.includes('secret to business A only'));
    const callWithB = allSentText.find((text) => text.includes('secret to business B only'));
    expect(callWithA).toBeDefined();
    expect(callWithB).toBeDefined();
    expect(callWithA).not.toContain('secret to business B only');
    expect(callWithB).not.toContain('secret to business A only');
  }, 25_000);

  it('10. AI success followed by an outbound-send failure never retries generation - exactly one real Gemini call', async () => {
    aiReplyGenerateContentMock.mockResolvedValueOnce({ text: 'This reply generated fine.' });
    const { businessId, accountId, accountJid } = await setupBusinessWithAgent();

    const sendSpy = vi.spyOn(whatsappOutboundMessageService, 'send').mockRejectedValueOnce(new Error('simulated DB error on send'));

    const debounceRound = waitForDebounceRound(businessId, 15_000);
    await sendAndWaitPersisted(businessId, accountId, accountJid, `SENDFAIL-${Date.now()}`, 'please reply to me');
    await debounceRound;

    expect(aiReplyGenerateContentMock).toHaveBeenCalledTimes(1); // generation succeeded, only the send failed
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // No outbound row exists (the send genuinely failed), but nothing
    // retried AI generation for it - a second debounce round never fires
    // on its own, and the watermark already advanced past this message.
    const { rows } = await pool.query('SELECT count(*) AS count FROM whatsapp_outbound_messages WHERE business_id = $1', [
      businessId,
    ]);
    expect(Number(rows[0].count)).toBe(0);

    sendSpy.mockRestore();
  }, 20_000);

  void randomBytes;
  void AI_DEBOUNCE_DELAY_MS;
});
