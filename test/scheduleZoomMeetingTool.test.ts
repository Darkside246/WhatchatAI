import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository, type AiAgentRecord } from '../src/repositories/aiAgentRepository.js';
import { ZoomMeetingRepository } from '../src/repositories/zoomMeetingRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import type { AiHandoffContext } from '../src/services/aiContextGathererService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';
import { buildTimeContext } from '../src/services/time/timeContext.js';
import { SCHEDULE_ZOOM_MEETING_TOOL_NAME } from '../src/services/meeting/scheduleZoomMeetingTool.js';
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
    // Offered to Gemini by default so schedule_zoom_meeting is even in the
    // declared tools array - the "not_connected" test below deliberately
    // still has no real DB connection row despite this, to prove the
    // tool's own execution-time check is the real source of truth (see
    // buildReplyTools in aiReplyService.ts).
    connectedMeetingProviders: ['zoom'],
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
    title: 'Property viewing follow-up',
    startDateTimeIso: '2030-06-01T15:00:00.000Z',
    ...overrides,
  };
}

/**
 * Mirrors scheduleMeetingTool.test.ts's own coverage exactly (real
 * generateAiReply -> Gemini requests schedule_zoom_meeting ->
 * executeOneToolCall's Zoom dispatch branch, agentGuard's real Postgres
 * checks exercised generically in agentGuard.test.ts). The one real
 * difference under test: attendeeEmail is genuinely optional here.
 */
describe('schedule_zoom_meeting tool (real Postgres + real guardToolInvocation, mocked Gemini + mocked Zoom API)', () => {
  let businessId: string;
  let agentId: string;
  let chatId: string;
  const meetingRepo = new ZoomMeetingRepository(pool);

  beforeEach(async () => {
    generateContentMock.mockReset();
    fetchMock.mockReset();
    await resetDatabase();

    const owner = await register(
      { email: 'zoom-tool-test@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent' });
    agentId = agent.id;

    const accountId = await createTestAccount(businessId);
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550006666@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected and writes nothing when the business has no Zoom connection', async () => {
    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_ZOOM_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: "I'm not able to book meetings right now." });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    expect(fetchMock).not.toHaveBeenCalled();
    const response = lastFunctionResponse();
    expect(response).toEqual({ booked: false, reason: 'not_connected' });

    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('returns missing_required_fields and never calls the Zoom API when a required arg is absent, even though the schema marks it required', async () => {
    await connectZoom();
    generateContentMock
      .mockResolvedValueOnce({
        text: undefined,
        functionCalls: [{ name: SCHEDULE_ZOOM_MEETING_TOOL_NAME, args: { title: 'No start time given' } }],
      })
      .mockResolvedValueOnce({ text: 'What time works for you?' });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastFunctionResponse()).toEqual({ booked: false, reason: 'missing_required_fields' });
  });

  it('books a real meeting with no attendeeEmail at all - it is genuinely optional, not silently defaulted', async () => {
    await connectZoom();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 987654321, join_url: 'https://zoom.us/j/987654321' }));
    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_ZOOM_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: "You're all set - here's the Zoom link." });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    const response = lastFunctionResponse() as { booked: boolean; joinUrl: string };
    expect(response.booked).toBe(true);
    expect(response.joinUrl).toBe('https://zoom.us/j/987654321');

    const rows = await pool.query<{ attendee_email: string | null }>(
      'SELECT attendee_email FROM scheduled_meetings WHERE business_id = $1',
      [businessId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.attendee_email).toBeNull();
  });

  it('returns zoom_api_error and writes nothing when the real Zoom API call fails', async () => {
    await connectZoom();
    fetchMock.mockResolvedValueOnce(new Response('Internal error', { status: 500 }));
    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_ZOOM_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: 'Something went wrong booking that - let me try again shortly.' });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    const response = lastFunctionResponse() as { booked: boolean; reason: string };
    expect(response.booked).toBe(false);
    expect(response.reason).toBe('zoom_api_error');

    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('books a real meeting on success, sends the exact required Zoom request shape, and records the real attendeeEmail when one is given', async () => {
    await connectZoom();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 123456789, join_url: 'https://zoom.us/j/123456789' }));
    generateContentMock
      .mockResolvedValueOnce({
        text: undefined,
        functionCalls: [{ name: SCHEDULE_ZOOM_MEETING_TOOL_NAME, args: toolCallArgs({ attendeeEmail: 'customer@example.com', durationMinutes: 45 }) }],
      })
      .mockResolvedValueOnce({ text: "You're all set - here's the Zoom link." });

    await generateAiReply(fakeAgent({ id: agentId, businessId }), fakeContext({ businessId, chatId }));

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://api.zoom.us/v2/users/me/meetings');
    const sentBody = JSON.parse((call?.[1]?.body as string) ?? '{}');
    expect(sentBody.topic).toBe('Property viewing follow-up');
    expect(sentBody.type).toBe(2);
    expect(sentBody.duration).toBe(45);
    expect(sentBody.start_time).toBe('2030-06-01T15:00:00.000Z');

    const response = lastFunctionResponse() as { booked: boolean; joinUrl: string; title: string };
    expect(response.booked).toBe(true);
    expect(response.joinUrl).toBe('https://zoom.us/j/123456789');

    const rows = await pool.query<{ meet_url: string; attendee_email: string | null; external_event_id: string }>(
      'SELECT meet_url, attendee_email, external_event_id FROM scheduled_meetings WHERE business_id = $1',
      [businessId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.meet_url).toBe('https://zoom.us/j/123456789');
    expect(rows.rows[0]?.attendee_email).toBe('customer@example.com');
    expect(rows.rows[0]?.external_event_id).toBe('123456789');
  });

  it('denies the tool call for a cross-tenant agent, the same way guardToolInvocation denies any other registered tool', async () => {
    await connectZoom();
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAgent = await new AiAgentRepository(pool).create({ businessId: otherBusinessId, name: 'Other Agent' });

    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_ZOOM_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: 'ok' });

    // The agent record genuinely exists and is ACTIVE, but belongs to a
    // different business than the one in context - guardToolInvocation
    // must reject it before scheduleZoomMeetingTool's own logic ever runs.
    await generateAiReply(fakeAgent({ id: otherAgent.id, businessId }), fakeContext({ businessId, chatId }));

    expect(fetchMock).not.toHaveBeenCalled();
    const response = lastFunctionResponse() as { error?: string };
    expect(response.error).toBeTruthy();
  });

  async function connectZoom(): Promise<void> {
    await meetingRepo.upsertConnection({
      businessId,
      zoomEmail: 'connected@example.com',
      zoomUserId: 'zoom-user-connected',
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
  }

  it('an agent with requiresApprovalForActions on never books immediately - it creates a real pending action in the approval queue instead', async () => {
    await connectZoom();
    generateContentMock
      .mockResolvedValueOnce({ text: undefined, functionCalls: [{ name: SCHEDULE_ZOOM_MEETING_TOOL_NAME, args: toolCallArgs() }] })
      .mockResolvedValueOnce({ text: "Let me check with the team and confirm shortly." });

    await generateAiReply(fakeAgent({ id: agentId, businessId, requiresApprovalForActions: true }), fakeContext({ businessId, chatId }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastFunctionResponse()).toEqual({ booked: false, reason: 'pending_approval' });

    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(0);

    const { ApprovalService } = await import('../src/services/platform/approvalService.js');
    const pending = await new ApprovalService(pool).listPending(businessId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.type).toBe('meeting.schedule_zoom_meeting');
    expect(pending[0]?.payload).toMatchObject({ chatId, title: 'Property viewing follow-up' });
  });

  function lastFunctionResponse(): unknown {
    const followUpContents = generateContentMock.mock.calls[1]?.[0]?.contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: { name: string; response: Record<string, unknown> } }>;
    }>;
    return followUpContents?.at(-1)?.parts[0]?.functionResponse?.response;
  }
});
