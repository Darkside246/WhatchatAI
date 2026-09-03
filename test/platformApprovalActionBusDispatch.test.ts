import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { initializePlatformFoundation } from '../src/services/platform/platformBootstrap.js';
import { actionBusService } from '../src/services/platform/actionBusService.js';
import { actionRowToRequest, humanApprovalCapability, runPostApprovalSideEffects } from '../src/server/platformApprovalRouter.js';
import { MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE } from '../src/services/property/maintenanceWorkOrderExecutor.js';
import { SCHEDULE_GOOGLE_MEET_ACTION_TYPE } from '../src/services/meeting/googleMeetBookingExecutor.js';
import { PropertyOperationsRepository } from '../src/repositories/propertyOperationsRepository.js';
import { GoogleMeetingRepository } from '../src/repositories/googleMeetingRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, createTestUser } from './helpers.js';
import type { PlatformActionRow } from '../src/repositories/platformActionRepository.js';
import type { AuthContext } from '../src/server/authMiddleware.js';

function fakeAuth(overrides: Partial<AuthContext>): AuthContext {
  return {
    userId: 'user-1',
    businessId: 'business-1',
    role: 'OWNER' as AuthContext['role'],
    platformRole: 'CLIENT' as AuthContext['platformRole'],
    sessionId: 'session-1',
    user: {} as AuthContext['user'],
    ...overrides,
  };
}

async function createTestProperty(businessId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO property_properties (business_id, name) VALUES ($1, $2) RETURNING id', [businessId, 'Test Villa']);
  return rows[0]!.id;
}

function fakeApprovedRow(overrides: Partial<PlatformActionRow> = {}): PlatformActionRow {
  return {
    id: 'action-1',
    businessId: 'business-1',
    type: MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE,
    payload: { propertyId: 'property-1', category: 'PLUMBING', urgency: 'URGENT', summary: 'Leak' },
    requestedByKind: 'AGENT',
    requestedById: 'property-maintenance-triage',
    riskLevel: 'MEDIUM',
    approvalRequired: true,
    approvalStatus: 'APPROVED',
    status: 'READY',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    executionResult: null,
    executionError: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('platformApprovalRouter helper functions', () => {
  it('actionRowToRequest maps every field, including a real approval.status of APPROVED', () => {
    const row = fakeApprovedRow();
    const request = actionRowToRequest(row);
    expect(request).toMatchObject({
      id: 'action-1',
      tenantId: 'business-1',
      type: MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE,
      requestedBy: { kind: 'AGENT', id: 'property-maintenance-triage' },
      riskLevel: 'MEDIUM',
      approval: { required: true, status: 'APPROVED' },
      status: 'READY',
      idempotencyKey: 'idem-1',
      correlationId: 'corr-1',
    });
    expect(request.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('humanApprovalCapability scopes allowedActions to exactly the one action type, and matches the original requester agentId', () => {
    const request = actionRowToRequest(fakeApprovedRow());
    const capability = humanApprovalCapability(request);
    expect(capability.agentId).toBe('property-maintenance-triage');
    expect(capability.allowedActions).toEqual([MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE]);
    expect(capability.forbiddenActions).toEqual([]);
    expect(capability.maxRiskLevel).toBe('CRITICAL');
  });
});

describe('ActionBus real production dispatch (real bootstrap registration, real Postgres)', () => {
  it('platformBootstrap registers the real maintenance work order executor outside of any test', () => {
    initializePlatformFoundation();
    expect(actionBusService.listExecutors()).toContain(MAINTENANCE_CREATE_WORK_ORDER_ACTION_TYPE);
  });

  it('dispatches a real approved work-order action end-to-end and creates the real incident/work order', async () => {
    initializePlatformFoundation();
    const businessId = await createTestBusiness();
    const propertyId = await createTestProperty(businessId);

    const row = fakeApprovedRow({
      businessId,
      id: 'e2e-action-1',
      idempotencyKey: `e2e-idem-${businessId}`,
      payload: { propertyId, category: 'PLUMBING', urgency: 'URGENT', summary: 'Leaking pipe' },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });

    expect(result.status).toBe('SUCCEEDED');
    const { incidentId, workOrderId } = result.result as { incidentId: string; workOrderId: string };

    const propertyRepo = new PropertyOperationsRepository(pool);
    const incidents = await propertyRepo.listIncidents(businessId, propertyId);
    expect(incidents.map((i) => i.id)).toContain(incidentId);
    const workOrders = await propertyRepo.listWorkOrders(businessId, incidentId);
    expect(workOrders.map((w) => w.id)).toContain(workOrderId);
  });

  it('is idempotent - dispatching the same approved action twice creates exactly one incident/work order', async () => {
    initializePlatformFoundation();
    const businessId = await createTestBusiness();
    const propertyId = await createTestProperty(businessId);

    const row = fakeApprovedRow({
      businessId,
      id: 'e2e-action-2',
      idempotencyKey: `e2e-idem-repeat-${businessId}`,
      payload: { propertyId, category: 'ELECTRICAL', urgency: 'ROUTINE', summary: 'Flickering light' },
    });
    const request = actionRowToRequest(row);
    const capability = humanApprovalCapability(request);
    const context = { tenantId: businessId, actorId: 'approver-user-1' };

    const first = await actionBusService.execute(request, capability, context);
    const second = await actionBusService.execute(request, capability, context);

    expect(first.status).toBe('SUCCEEDED');
    expect(second.status).toBe('SUCCEEDED');
    expect(second.result).toEqual(first.result);

    const propertyRepo = new PropertyOperationsRepository(pool);
    const incidents = await propertyRepo.listIncidents(businessId, propertyId);
    expect(incidents).toHaveLength(1);
  });

  it('is a benign no-op (DENIED, not a failure) for an approved action type with no registered executor', async () => {
    initializePlatformFoundation();
    const businessId = await createTestBusiness();
    const row = fakeApprovedRow({
      businessId,
      id: 'e2e-action-3',
      type: 'maintenance.request_human_review',
      idempotencyKey: `e2e-idem-review-${businessId}`,
      payload: { propertyId: 'irrelevant' },
    });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: businessId, actorId: 'approver-user-1' });
    expect(result.status).toBe('DENIED');
    expect(result.error).toContain('no executor');
  });

  it('enforces tenant isolation - dispatch context tenantId must match the action', async () => {
    initializePlatformFoundation();
    const businessId = await createTestBusiness();
    const otherBusinessId = await createTestBusiness('Other Business');
    const row = fakeApprovedRow({ businessId, idempotencyKey: `e2e-idem-tenant-${businessId}` });
    const request = actionRowToRequest(row);
    const result = await actionBusService.execute(request, humanApprovalCapability(request), { tenantId: otherBusinessId, actorId: 'approver-user-1' });
    expect(result.status).toBe('DENIED');
  });
});

describe('runPostApprovalSideEffects (Sections 43-44/46-47: an approved action whose real execution fails must never look like a plain success)', () => {
  it('a FAILED dispatch gets an honest "failed to execute" notification, never the generic "approved" one', async () => {
    initializePlatformFoundation();
    const businessId = await createTestBusiness();
    await createTestUser(businessId); // notifyBusiness only reaches real active members

    // No Google connection exists at all - the cheapest real way to force
    // GoogleMeetBookingExecutor to a genuine FAILED (reason: not_connected),
    // no mocked fetch needed.
    const row = fakeApprovedRow({
      businessId,
      id: randomUUID(), // notifyBusiness's targetId flows into a real UUID column - a real action row's id is always a genuine UUID
      type: SCHEDULE_GOOGLE_MEET_ACTION_TYPE,
      idempotencyKey: `e2e-idem-failed-${businessId}`,
      payload: {
        chatId: 'irrelevant-chat-id',
        contactId: null,
        businessTimezone: 'UTC',
        attendeeEmail: 'customer@example.com',
        title: 'Never connected',
        startDateTimeIso: '2030-06-01T15:00:00.000Z',
      },
    });

    await runPostApprovalSideEffects(row, fakeAuth({ businessId, userId: 'approver-user-1' }), undefined);

    const { rows: notifications } = await pool.query<{ type: string; title: string; body: string | null }>(
      `SELECT type, title, body FROM notifications WHERE business_id = $1 ORDER BY created_at ASC`,
      [businessId],
    );
    expect(notifications).toHaveLength(1); // never both - the misleading "approved" one must not also fire
    expect(notifications[0]?.type).toBe('AUTOMATION_FAILURE');
    expect(notifications[0]?.title).toMatch(/failed to execute/i);
    expect(notifications[0]?.body).toContain('not_connected');
    expect(notifications[0]?.body).not.toMatch(/^Action request approved/i);
  });

  it('a genuinely SUCCEEDED dispatch still gets the ordinary "approved" notification', async () => {
    initializePlatformFoundation();
    const businessId = await createTestBusiness();
    await createTestUser(businessId);
    const propertyId = await createTestProperty(businessId);

    const row = fakeApprovedRow({
      businessId,
      id: 'e2e-action-succeeded-1',
      idempotencyKey: `e2e-idem-succeeded-${businessId}`,
      payload: { propertyId, category: 'PLUMBING', urgency: 'URGENT', summary: 'Leak' },
    });

    await runPostApprovalSideEffects(row, fakeAuth({ businessId, userId: 'approver-user-1' }), undefined);

    const { rows: notifications } = await pool.query<{ type: string; title: string }>(
      `SELECT type, title FROM notifications WHERE business_id = $1`,
      [businessId],
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('HUMAN_HANDOFF');
    expect(notifications[0]?.title).toMatch(/approved/i);
  });
});
