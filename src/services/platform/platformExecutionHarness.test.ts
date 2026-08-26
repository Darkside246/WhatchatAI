import { describe, expect, it } from 'vitest';
import type { ActionRequest, AgentCapability, AgentExecutionResult, AgentRuntimeAdapter } from '../../domain/platform/contracts.js';
import { buildSyntheticCommunicationEvent, runPlatformHarness } from './platformExecutionHarness.js';

const capability: AgentCapability = {
  id: 'property.maintenance.triage',
  agentId: 'agent-maintenance',
  description: 'Classifies property maintenance requests and proposes bounded actions.',
  allowedActions: ['maintenance.create_work_order', 'maintenance.request_human_review'],
  forbiddenActions: ['property.issue_refund', 'lease.modify', 'payment.authorize'],
  requiresApprovalFor: ['maintenance.create_work_order'],
  maxRiskLevel: 'HIGH',
};

function runtimeFor(actions: ActionRequest[]): AgentRuntimeAdapter {
  return {
    name: 'test-runtime',
    async execute(_task, _context): Promise<AgentExecutionResult> {
      return { status: 'completed', executionId: 'exec-test', output: { triage: 'complete' }, actionRequests: actions };
    },
    async cancel() {},
    async health() { return { healthy: true }; },
  };
}

function action(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: 'action-1',
    tenantId: 'tenant-1',
    type: 'maintenance.create_work_order',
    payload: { propertyId: 'property-1', priority: 'normal' },
    requestedBy: { kind: 'AGENT', id: 'agent-maintenance' },
    riskLevel: 'HIGH',
    approval: { required: true, status: 'NOT_REQUIRED' },
    status: 'PENDING_POLICY',
    correlationId: 'corr-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

describe('platformExecutionHarness', () => {
  it('builds a valid synthetic communication event', () => {
    const event = buildSyntheticCommunicationEvent({
      tenantId: 'tenant-1',
      conversationId: 'chat-1',
      address: '+12465551234',
      propertyId: 'property-1',
      text: 'The air conditioner is not cooling.',
      clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    });

    expect(event.channel).toBe('WHATSAPP');
    expect(event.sender.role).toBe('GUEST');
    expect(event.propertyId).toBeUndefined();
    expect(event.message.type).toBe('TEXT');
  });

  it('routes a high-risk proposed action to explicit human approval', async () => {
    const event = buildSyntheticCommunicationEvent({
      tenantId: 'tenant-1',
      conversationId: 'chat-1',
      address: '+12465551234',
      text: 'There is a maintenance issue.',
    });

    const result = await runPlatformHarness({
      event,
      runtime: runtimeFor([action()]),
      agentId: 'agent-maintenance',
      capability,
      context: { tenantId: 'tenant-1', entityIds: ['property-1'] },
    });

    expect(result.execution.status).toBe('completed');
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.kind).toBe('HUMAN_APPROVAL');
    expect(result.decisions[0]?.action.status).toBe('PENDING_APPROVAL');
    expect(result.audit.map((entry) => entry.eventType)).toContain('APPROVAL_REQUESTED');
  });

  it('rejects an agent action outside its capability manifest', async () => {
    const event = buildSyntheticCommunicationEvent({
      tenantId: 'tenant-1',
      conversationId: 'chat-1',
      address: '+12465551234',
      text: 'Please change my lease.',
    });

    const result = await runPlatformHarness({
      event,
      runtime: runtimeFor([action({ type: 'lease.modify' })]),
      agentId: 'agent-maintenance',
      capability,
      context: { tenantId: 'tenant-1', entityIds: ['property-1'] },
    });

    expect(result.decisions).toEqual([]);
    expect(result.audit.map((entry) => entry.eventType)).toContain('ACTION_REJECTED_CAPABILITY');
  });

  it('fails closed on a cross-tenant action request', async () => {
    const event = buildSyntheticCommunicationEvent({
      tenantId: 'tenant-1',
      conversationId: 'chat-1',
      address: '+12465551234',
      text: 'The property has a leak.',
    });

    await expect(runPlatformHarness({
      event,
      runtime: runtimeFor([action({ tenantId: 'tenant-2' })]),
      agentId: 'agent-maintenance',
      capability,
      context: { tenantId: 'tenant-1', entityIds: ['property-1'] },
    })).rejects.toThrow('cross-tenant ActionRequest');
  });

  it('fails closed when event context tenants disagree', async () => {
    const event = buildSyntheticCommunicationEvent({
      tenantId: 'tenant-1',
      conversationId: 'chat-1',
      address: '+12465551234',
      text: 'The pool heater is not working.',
    });

    await expect(runPlatformHarness({
      event,
      runtime: runtimeFor([]),
      agentId: 'agent-maintenance',
      capability,
      context: { tenantId: 'tenant-2', entityIds: ['property-9'] },
    })).rejects.toThrow('event and context tenant IDs differ');
  });
});
