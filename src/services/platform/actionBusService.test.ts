import { describe, expect, beforeEach, it } from 'vitest';
import type { ActionRequest, AgentCapability } from '../../domain/platform/contracts.js';
import { actionBusService } from './actionBusService.js';
import { auditLedgerService } from './auditLedgerService.js';

const capability: AgentCapability = {
  id: 'skill.test', agentId: 'agent-1', description: 'test',
  allowedActions: ['test.echo'], forbiddenActions: ['test.forbidden'],
  requiresApprovalFor: [], maxRiskLevel: 'HIGH',
};

function action(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: 'action-1', tenantId: 'tenant-1', type: 'test.echo', payload: { value: 1 },
    requestedBy: { kind: 'AGENT', id: 'agent-1' }, riskLevel: 'LOW',
    approval: { required: false, status: 'NOT_REQUIRED' }, status: 'PENDING_POLICY',
    idempotencyKey: 'test:echo:1', correlationId: 'corr-1', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

describe('ActionBusService', () => {
  beforeEach(() => { auditLedgerService.clear(); });

  it('denies an action from another tenant', async () => {
    const result = await actionBusService.execute(action({ tenantId: 'tenant-2' }), capability, { tenantId: 'tenant-1', actorId: 'user-1' });
    expect(result.status).toBe('DENIED');
  });

  it('requires approval for high-risk actions', async () => {
    const result = await actionBusService.execute(action({ riskLevel: 'HIGH', approval: { required: true, status: 'PENDING' } }), capability, { tenantId: 'tenant-1', actorId: 'user-1' });
    expect(result.status).toBe('AWAITING_APPROVAL');
  });

  it('does not execute an approved action without a registered executor', async () => {
    const result = await actionBusService.execute(action({ riskLevel: 'LOW', approval: { required: true, status: 'APPROVED' } }), capability, { tenantId: 'tenant-1', actorId: 'user-1' });
    expect(result.status).toBe('DENIED');
    expect(result.error).toContain('no executor');
  });

  it('executes and de-duplicates an approved action', async () => {
    const executor = { actionType: 'test.echo', async execute() { return { status: 'SUCCEEDED' as const, result: { ok: true } }; } };
    actionBusService.register(executor);
    const approved = action({ approval: { required: true, status: 'APPROVED' } });
    const first = await actionBusService.execute(approved, capability, { tenantId: 'tenant-1', actorId: 'user-1' });
    const second = await actionBusService.execute(approved, capability, { tenantId: 'tenant-1', actorId: 'user-1' });
    expect(first.status).toBe('SUCCEEDED');
    expect(second.status).toBe('SUCCEEDED');
    expect(second.result).toEqual(first.result);
    expect(auditLedgerService.verify('tenant-1')).toBe(true);
  });
});
