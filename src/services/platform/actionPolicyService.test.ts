import { describe, expect, it } from 'vitest';
import { evaluateActionPolicy } from './actionPolicyService.js';
import type { ActionRequest, AgentCapability } from '../../domain/platform/contracts.js';

const capability: AgentCapability = {
  id: 'property.maintenance.triage', agentId: 'agent-1', description: 'Maintenance triage',
  allowedActions: ['maintenance.create_work_order'], forbiddenActions: ['lease.modify'], requiresApprovalFor: ['maintenance.create_work_order'], maxRiskLevel: 'HIGH',
};

const action = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id: 'action-1', tenantId: 'tenant-1', type: 'maintenance.create_work_order', payload: {},
  requestedBy: { kind: 'AGENT', id: 'agent-1' }, riskLevel: 'HIGH', approval: { required: true, status: 'NOT_REQUIRED' }, status: 'PENDING_POLICY',
  idempotencyKey: 'test:action-1', correlationId: 'corr-1', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
});

describe('evaluateActionPolicy', () => {
  it('requires approval for capability-declared actions', () => {
    const result = evaluateActionPolicy(action(), capability);
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    if (result.decision === 'REQUIRE_APPROVAL') expect(result.action.status).toBe('PENDING_APPROVAL');
  });
  it('denies an unlisted action', () => expect(evaluateActionPolicy(action({ type: 'payment.authorize' }), capability).decision).toBe('DENY'));
  it('denies an explicitly forbidden action', () => expect(evaluateActionPolicy(action({ type: 'lease.modify' }), { ...capability, allowedActions: ['lease.modify'] }).decision).toBe('DENY'));
  it('denies an agent acting under a different identity', () => expect(evaluateActionPolicy(action({ requestedBy: { kind: 'AGENT', id: 'agent-evil' } }), capability).decision).toBe('DENY'));
  it('denies risk above the capability maximum', () => expect(evaluateActionPolicy(action({ riskLevel: 'CRITICAL' }), capability).decision).toBe('DENY'));
  it('allows low-risk actions that are permitted and do not require approval', () => {
    const lowRiskCapability: AgentCapability = { ...capability, allowedActions: ['maintenance.add_note'], requiresApprovalFor: [], maxRiskLevel: 'LOW' };
    const result = evaluateActionPolicy(action({ type: 'maintenance.add_note', riskLevel: 'LOW', approval: { required: false, status: 'NOT_REQUIRED' } }), lowRiskCapability);
    expect(result.decision).toBe('ALLOW');
    if (result.decision === 'ALLOW') expect(result.action.status).toBe('READY');
  });
});
