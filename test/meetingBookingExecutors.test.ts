import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { initializePlatformFoundation } from '../src/services/platform/platformBootstrap.js';
import { actionBusService } from '../src/services/platform/actionBusService.js';
import { humanApprovalCapability, actionRowToRequest } from '../src/server/platformApprovalRouter.js';
import { SCHEDULE_GOOGLE_MEET_ACTION_TYPE } from '../src/services/meeting/googleMeetBookingExecutor.js';
import { SCHEDULE_ZOOM_MEETING_ACTION_TYPE } from '../src/services/meeting/zoomMeetBookingExecutor.js';
import { GoogleMeetingRepository } from '../src/repositories/googleMeetingRepository.js';
import { ZoomMeetingRepository } from '../src/repositories/zoomMeetingRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, createTestUser, resetDatabase } from './helpers.js';
import type { PlatformActionRow } from '../src/repositories/platformActionRepository.js';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let chatCounter = 0;
async function createTestChat(businessId: string): Promise<string> {
  chatCounter += 1;
  const accountId = await createTestAccount(businessId, `1555000${String(chatCounter).padStart(4, '0')}@s.whatsapp.net`);
  const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
    businessId,
    whatsappAccountId: accountId,
    chatJid: `1555000${String(chatCounter).padStart(4, '0')}@s.whatsapp.net`,
    jidKind: 'individual',
    chatType: 'individual',
  });
  return chat.id;
}

function fakeApprovedRow(overrides: Partial<PlatformActionRow> = {}): PlatformActionRow {
  return {
    id: randomUUID(),
    businessId: 'business-1',
    type: SCHEDULE_GOOGLE_MEET_ACTION_TYPE,
    payload: {},
    requestedByKind: 'AGENT',
    requestedById: 'agent-1',
    riskLevel: 'MEDIUM',
    approvalRequired: true,
    approvalStatus: 'APPROVED',
    status: 'READY',
    idempotencyKey: `test-idem-${randomUUID()}`,
    correlationId: randomUUID(),
    executionResult: null,
    executionError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * These executors are only ever reachable once an operator approves a
 * pending action aiReplyService.ts's createPendingApprovalAction created
 * (see the "autonomy level 2" tests in scheduleMeetingTool.test.ts
 * / scheduleZoomMeetingTool.test.ts) - this file proves the other half:
 * that approving one of these actions really does book the real meeting,
 * the same way platformApprovalActionBusDispatch.test.ts already proves
 * for maintenance.create_work_order.
 */
describe('GoogleMeetBookingExecutor / ZoomMeetBookingExecutor (real ActionBus dispatch, real Postgres, mocked external APIs)', () => {
  let businessId: string;
  let agentId: string;

  beforeEach(async () => {
    fetchMock.mockReset();
    await resetDatabase();
    initializePlatformFoundation();
    businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent' });
    agentId = agent.id;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('platformBootstrap registers both booking executors outside of any test', () => {
    initializePlatformFoundation();
    expect(actionBusService.listExecutors()).toContain(SCHEDULE_GOOGLE_MEET_ACTION_TYPE);
    expect(actionBusService.listExecutors()).toContain(SCHEDULE_ZOOM_MEETING_ACTION_TYPE);
  });

  it('dispatches a real approved Google Meet booking action and actually books it', async () => {
    await new GoogleMeetingRepository(pool).upsertConnection({
      businessId,
      googleEmail: 'connected@example.com',
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'google-event-approved-1',
        htmlLink: 'https://calendar.google.com/event?eid=approved',
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/approved-1' }] },
      }),
    );

    const row = fakeApprovedRow({
      businessId,
      requestedById: agentId,
      type: SCHEDULE_GOOGLE_MEET_ACTION_TYPE,
      payload: {
        chatId: await createTestChat(businessId),
        contactId: null,
        businessTimezone: 'UTC',
        attendeeEmail: 'customer@example.com',
        title: 'Approved viewing',
        startDateTimeIso: '2030-06-01T15:00:00.000Z',
      },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.result).toMatchObject({ meetUrl: 'https://meet.google.com/approved-1', title: 'Approved viewing' });

    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(1);
  });

  it('reports a real FAILED (not a fabricated success) when the approved action has no real connection to book with', async () => {
    const row = fakeApprovedRow({
      businessId,
      requestedById: agentId,
      type: SCHEDULE_GOOGLE_MEET_ACTION_TYPE,
      payload: { chatId: randomUUID(), contactId: null, businessTimezone: 'UTC', attendeeEmail: 'customer@example.com', title: 'No connection', startDateTimeIso: '2030-06-01T15:00:00.000Z' },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('not_connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dispatches a real approved Zoom booking action and actually books it', async () => {
    await new ZoomMeetingRepository(pool).upsertConnection({
      businessId,
      zoomEmail: 'connected@example.com',
      zoomUserId: 'zoom-user-1',
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 123456789, join_url: 'https://zoom.us/j/123456789' }));

    const row = fakeApprovedRow({
      businessId,
      requestedById: agentId,
      type: SCHEDULE_ZOOM_MEETING_ACTION_TYPE,
      payload: { chatId: await createTestChat(businessId), contactId: null, businessTimezone: 'UTC', title: 'Approved Zoom call', startDateTimeIso: '2030-06-01T15:00:00.000Z' },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.result).toMatchObject({ joinUrl: 'https://zoom.us/j/123456789', title: 'Approved Zoom call' });

    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(1);
  });

  it('a dead Google refresh token (revoked/expired) reports FAILED and notifies the business to reconnect - not just a silent tool-call failure', async () => {
    await createTestUser(businessId); // notifyBusiness only reaches real active members
    const connection = await new GoogleMeetingRepository(pool).upsertConnection({
      businessId,
      googleEmail: 'connected@example.com',
      accessToken: 'stale-access-token',
      refreshToken: 'dead-refresh-token',
      tokenExpiresAt: new Date(Date.now() - 1000), // already expired, forces the refresh path
    });
    // The one fetch call this makes is the token refresh itself - Google
    // rejects a revoked refresh_token with a real non-2xx response.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));

    const row = fakeApprovedRow({
      businessId,
      requestedById: agentId,
      type: SCHEDULE_GOOGLE_MEET_ACTION_TYPE,
      payload: {
        chatId: await createTestChat(businessId),
        contactId: null,
        businessTimezone: 'UTC',
        attendeeEmail: 'customer@example.com',
        title: 'Dead connection',
        startDateTimeIso: '2030-06-01T15:00:00.000Z',
      },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('token_invalid');

    const { rows: notifications } = await pool.query<{ title: string; target_id: string }>(
      `SELECT title, target_id FROM notifications WHERE business_id = $1 AND type = 'AUTOMATION_FAILURE'`,
      [businessId],
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toMatch(/Google Meet needs to be reconnected/i);
    expect(notifications[0]?.target_id).toBe(connection.id);
  });

  it('a dead Zoom refresh token reports FAILED and notifies the business to reconnect', async () => {
    await createTestUser(businessId); // notifyBusiness only reaches real active members
    const connection = await new ZoomMeetingRepository(pool).upsertConnection({
      businessId,
      zoomEmail: 'connected@example.com',
      zoomUserId: 'zoom-user-1',
      accessToken: 'stale-access-token',
      refreshToken: 'dead-refresh-token',
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));

    const row = fakeApprovedRow({
      businessId,
      requestedById: agentId,
      type: SCHEDULE_ZOOM_MEETING_ACTION_TYPE,
      payload: { chatId: await createTestChat(businessId), contactId: null, businessTimezone: 'UTC', title: 'Dead Zoom connection', startDateTimeIso: '2030-06-01T15:00:00.000Z' },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('token_invalid');

    const { rows: notifications } = await pool.query<{ title: string; target_id: string }>(
      `SELECT title, target_id FROM notifications WHERE business_id = $1 AND type = 'AUTOMATION_FAILURE'`,
      [businessId],
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toMatch(/Zoom needs to be reconnected/i);
    expect(notifications[0]?.target_id).toBe(connection.id);
  });

  it('an approval that sat long enough for its own proposed Google Meet time to pass is refused, never silently booked for a moment already gone', async () => {
    await new GoogleMeetingRepository(pool).upsertConnection({
      businessId,
      googleEmail: 'connected@example.com',
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });

    const row = fakeApprovedRow({
      businessId,
      requestedById: agentId,
      type: SCHEDULE_GOOGLE_MEET_ACTION_TYPE,
      payload: {
        chatId: await createTestChat(businessId),
        contactId: null,
        businessTimezone: 'UTC',
        attendeeEmail: 'customer@example.com',
        title: 'Approved too late',
        startDateTimeIso: '2020-01-01T15:00:00.000Z', // long past by the time this "approval" happens
      },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('start_time_already_passed');
    expect(fetchMock).not.toHaveBeenCalled(); // never even attempts the real Calendar call
    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('an approval that sat long enough for its own proposed Zoom time to pass is refused, never silently booked', async () => {
    await new ZoomMeetingRepository(pool).upsertConnection({
      businessId,
      zoomEmail: 'connected@example.com',
      zoomUserId: 'zoom-user-1',
      accessToken: 'valid-access-token',
      refreshToken: 'valid-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });

    const row = fakeApprovedRow({
      businessId,
      requestedById: agentId,
      type: SCHEDULE_ZOOM_MEETING_ACTION_TYPE,
      payload: { chatId: await createTestChat(businessId), contactId: null, businessTimezone: 'UTC', title: 'Approved too late', startDateTimeIso: '2020-01-01T15:00:00.000Z' },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('start_time_already_passed');
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await pool.query('SELECT id FROM scheduled_meetings WHERE business_id = $1', [businessId]);
    expect(rows.rows).toHaveLength(0);
  });
});
