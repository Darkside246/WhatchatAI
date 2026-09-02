import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ApprovalService } from '../src/services/platform/approvalService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';
import type { ActionRequest } from '../src/domain/platform/contracts.js';

function fakeAction(businessId: string, overrides: Partial<ActionRequest> = {}): ActionRequest {
  const id = randomUUID();
  return {
    id,
    tenantId: businessId,
    type: 'maintenance.request_human_review',
    payload: { summary: 'Test escalation', category: 'PLUMBING', urgency: 'ROUTINE', confidence: 0.8 },
    requestedBy: { kind: 'AGENT', id: 'property-maintenance-triage' },
    riskLevel: 'MEDIUM',
    approval: { required: true, status: 'PENDING' },
    status: 'PENDING_APPROVAL',
    idempotencyKey: `test-idem-${id}`,
    correlationId: randomUUID(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ApprovalService (real Postgres - the state machine behind Approve/Reject and Approve All)', () => {
  it('persistAction creates a real pending approval row when approval is required', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const service = new ApprovalService(pool);
    const action = fakeAction(businessId);

    const row = await service.persistAction(action);
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.approvalStatus).toBe('PENDING');

    const pending = await service.listPending(businessId);
    expect(pending.map((a) => a.id)).toContain(action.id);
  });

  it('persistAction does not create a pending approval when the action does not require one', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const service = new ApprovalService(pool);
    const action = fakeAction(businessId, { approval: { required: false, status: 'NOT_REQUIRED' }, status: 'READY' });

    await service.persistAction(action);
    const pending = await service.listPending(businessId);
    expect(pending).toHaveLength(0);
  });

  it('approve() transitions a real pending action to APPROVED/READY', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const service = new ApprovalService(pool);
    const action = fakeAction(businessId);
    await service.persistAction(action);

    const approved = await service.approve({ businessId, actionId: action.id, userId: randomUUID(), reason: 'Looks legitimate' });
    expect(approved.approvalStatus).toBe('APPROVED');
    expect(approved.status).toBe('READY');

    expect(await service.listPending(businessId)).toHaveLength(0);
  });

  it('reject() transitions a real pending action to REJECTED/CANCELLED', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const service = new ApprovalService(pool);
    const action = fakeAction(businessId);
    await service.persistAction(action);

    const rejected = await service.reject({ businessId, actionId: action.id, userId: randomUUID(), reason: 'Tenant responsibility' });
    expect(rejected.approvalStatus).toBe('REJECTED');
    expect(rejected.status).toBe('CANCELLED');
  });

  it('throws ACTION_NOT_FOUND for an action id that does not exist', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const service = new ApprovalService(pool);
    await expect(service.approve({ businessId, actionId: randomUUID(), userId: randomUUID() })).rejects.toThrow('ACTION_NOT_FOUND');
  });

  it('throws ACTION_NOT_PENDING_APPROVAL on a second decision - the exact case Approve All must handle per-item, not fail the whole batch', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const service = new ApprovalService(pool);
    const action = fakeAction(businessId);
    await service.persistAction(action);

    await service.approve({ businessId, actionId: action.id, userId: randomUUID() });
    await expect(service.approve({ businessId, actionId: action.id, userId: randomUUID() })).rejects.toThrow('ACTION_NOT_PENDING_APPROVAL');
  });

  it('never returns another business\'s pending action - real tenant isolation', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const otherBusinessId = await createTestBusiness('Other Business');
    const service = new ApprovalService(pool);
    await service.persistAction(fakeAction(businessId));
    await service.persistAction(fakeAction(otherBusinessId));

    const pending = await service.listPending(businessId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.businessId).toBe(businessId);
  });

  it('approving one action never affects a sibling pending action on the same business - proves independent per-item decisions, the mechanism the bulk-approve route relies on', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const service = new ApprovalService(pool);
    const actionA = fakeAction(businessId);
    const actionB = fakeAction(businessId);
    await service.persistAction(actionA);
    await service.persistAction(actionB);

    await service.approve({ businessId, actionId: actionA.id, userId: randomUUID() });

    const stillPending = await service.listPending(businessId);
    expect(stillPending.map((a) => a.id)).toEqual([actionB.id]);
  });
});
