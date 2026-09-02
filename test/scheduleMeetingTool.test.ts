import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository, type AiAgentRecord } from '../src/repositories/aiAgentRepository.js';
import { GoogleMeetingRepository } from '../src/repositories/googleMeetingRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import type { AiHandoffContext } from '../src/services/aiContextGathererService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';
import { buildTimeContext } from '../src/services/time/timeContext.js';
import { SCHEDULE_MEETING_TOOL_NAME } from '../src/services/meeting/scheduleMeetingTool.js';
import { register } from '../src/services/authService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

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
    textContent: 'Can we book a call for tomorrow at 3pm?',
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
    documentContext: { available: false, results: [], reason: 'not configured' },
    conversationHistory: [fakeMessage()],
    businessTimezone,
    timeContext,
    // Offered to Gemini by default so schedule_google_meet is even in the
    // declared tools array - the "not_connected" test below deliberately
    // still has no real DB connection row despite this, to prove the
    // tool's own execution-time check is the real source of truth, not
    // just this context-level offer/don't-offer optimization (see
    // buildReplyTools in aiReplyService.ts).
    connectedMeetingProviders: ['google_meet'],
    ...overrides,
  };
}

const generateContentMock = vi.fn();
vi.mock('../src/services/geminiClient.js', () => ({
  getGeminiClient: () => ({ models: { generateContent: (...args: unknown[]) => generateContentMock(...args) } }),
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const { generateAiReply } = await import('../src/services/aiReplyService.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function toolCallArgs(overrides: Record<string, unknown> = {}) {
  return {
    attendeeEmail: 'customer@example.com',
    title: 'Property viewing follow-up',
    startDateTimeIso: '2030-06-01T15:00:00.000Z',
    ...overrides,
  };
}

/**
 * Exercises the real tool wiring end to end: generateAiReply -> Gemini
 * requests schedule_google_meet -> executeOneToolCall's dispatch branch
 * (agentGuard.ts's real Postgres tenant/actor/rate-limit checks are
 * exercised generically for every registered tool in agentGuard.test.ts;
 * this file proves this specific tool's own branch behaves honestly).
 */
describe('schedule_google_meet tool (real Postgres + real guardToolInvocation, mocked Gemini + mocked Calendar API)', () => {
  let businessId: string;
  let agentId: string;
  let chatId: string;
  const meetingRepo = new GoogleMeetingRepository(pool);

  beforeEach(async () => {
    generateContentMock.mockReset();
    fetchMock.mockReset();
    await resetDatabase();

    const owner = await register(
      { email: 'meeting-tool-test@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent' });
    agentId = agent.id;

    const accountId = await createTestAccount(businessId);
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550005555@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected and writes nothing when the business has no Google Meet connection', async () => {
    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: "I'm not able to book meetings right now." });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    expect(fetchMock).not.toHaveBeenCalled();
    const response = lastFunctionResponse();
    expect(response).toEqual({ booked: false, reason: 'not_connected' });

    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('returns missing_required_fields and never calls the Calendar API when a required arg is absent, even though the schema marks it required', async () => {
    await connectGoogleMeeting();
    generateContentMock
      .mockResolvedValueOnce({
        text: undefined,
        functionCalls: [{ name: SCHEDULE_MEETING_TOOL_NAME, args: { title: 'No email given', startDateTimeIso: '2030-06-01T15:00:00.000Z' } }],
      })
      .mockResolvedValueOnce({ text: 'Could I get your email address to send the invite to?' });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastFunctionResponse()).toEqual({ booked: false, reason: 'missing_required_fields' });
  });

  it('returns calendar_api_error and writes nothing when the real Calendar API call fails', async () => {
    await connectGoogleMeeting();
    fetchMock.mockResolvedValueOnce(new Response('Internal error', { status: 500 }));
    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: 'Something went wrong booking that - let me try again shortly.' });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    const response = lastFunctionResponse() as { booked: boolean; reason: string };
    expect(response.booked).toBe(false);
    expect(response.reason).toBe('calendar_api_error');

    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('books a real meeting on success, sends the exact required Calendar request shape, and takes the meet URL from the video entry point specifically', async () => {
    await connectGoogleMeeting();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'google-event-abc',
        htmlLink: 'https://calendar.google.com/event?eid=abc',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1-555-000-1111' },
            { entryPointType: 'more', uri: 'https://meet.google.com/abc-defg-hij?more' },
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
          ],
        },
      }),
    );
    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: "You're all set - I've sent a calendar invite with the Google Meet link." });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    const call = fetchMock.mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain('conferenceDataVersion=1');
    expect(url).toContain('sendUpdates=all');
    const sentBody = JSON.parse((call?.[1]?.body as string) ?? '{}');
    expect(sentBody.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
    expect(sentBody.attendees).toEqual([{ email: 'customer@example.com' }]);

    const response = lastFunctionResponse() as { booked: boolean; meetUrl: string; title: string };
    expect(response.booked).toBe(true);
    expect(response.meetUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(response.meetUrl).not.toBe('tel:+1-555-000-1111');

    const rows = await pool.query<{ meet_url: string; attendee_email: string; external_event_id: string }>(
      'SELECT meet_url, attendee_email, external_event_id FROM scheduled_meetings WHERE business_id = $1',
      [businessId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.meet_url).toBe('https://meet.google.com/abc-defg-hij');
    expect(rows.rows[0]?.attendee_email).toBe('customer@example.com');
    expect(rows.rows[0]?.external_event_id).toBe('google-event-abc');
  });

  it('denies the tool call for a cross-tenant agent, the same way guardToolInvocation denies any other registered tool', async () => {
    await connectGoogleMeeting();
    // register() provisions the one default business and only ever
    // succeeds once per resetDatabase() call (see helpers.ts's own
    // createTestUser doc comment) - a second, genuinely distinct business
    // needs createTestBusiness() instead.
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAgent = await new AiAgentRepository(pool).create({ businessId: otherBusinessId, name: 'Other Agent' });

    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: 'ok' });

    // The agent record genuinely exists and is ACTIVE, but belongs to a
    // different business than the one in context - guardToolInvocation
    // must reject it before scheduleMeetingTool's own logic ever runs.
    await generateAiReply(fakeAgent({ id: otherAgent.id, businessId }), fakeContext({ businessId, chatId }));

    expect(fetchMock).not.toHaveBeenCalled();
    const response = lastFunctionResponse() as { error?: string };
    expect(response.error).toBeTruthy();
  });

  async function connectGoogleMeeting(): Promise<void> {
    await meetingRepo.upsertConnection({
      businessId,
      googleEmail: 'connected@example.com',
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
  }

  function lastFunctionResponse(): unknown {
    const followUpContents = generateContentMock.mock.calls[1]?.[0]?.contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: { name: string; response: Record<string, unknown> } }>;
    }>;
    return followUpContents?.at(-1)?.parts[0]?.functionResponse?.response;
  }
});
