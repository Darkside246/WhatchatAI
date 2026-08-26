import { createHash, randomUUID } from 'node:crypto';
import { CommunicationEventSchema, type ActionRequest, type AgentTask, type CommunicationEvent, type AgentExecutionResult, type AuditEvent, type AgentCapability } from '../../domain/platform/contracts.js';
import type { AgentRuntimeAdapter } from '../../domain/platform/contracts.js';
import { evaluateActionPolicy, type ActionPolicyDecision } from './actionPolicyService.js';

export type HarnessDecision = ActionPolicyDecision;

export interface HarnessResult {
  communicationEvent: CommunicationEvent;
  task: AgentTask;
  execution: AgentExecutionResult;
  decisions: HarnessDecision[];
  audit: AuditEvent[];
}

export interface HarnessClock { now(): Date }

const DEFAULT_CLOCK: HarnessClock = { now: () => new Date() };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function auditDigest(event: Omit<AuditEvent, 'payloadHash' | 'previousHash'>): string {
  return sha256({
    id: event.id,
    tenantId: event.tenantId,
    eventType: event.eventType,
    actor: event.actor,
    correlationId: event.correlationId,
    actionRequestId: event.actionRequestId,
    payload: event.payload,
    occurredAt: event.occurredAt,
    metadata: event.metadata,
  });
}

export function buildSyntheticCommunicationEvent(input: {
  tenantId: string;
  conversationId: string;
  address: string;
  propertyId?: string;
  text: string;
  clock?: HarnessClock;
}): CommunicationEvent {
  const clock = input.clock ?? DEFAULT_CLOCK;
  return CommunicationEventSchema.parse({
    id: randomUUID(),
    tenantId: input.tenantId,
    channel: 'WHATSAPP',
    conversationId: input.conversationId,
    sender: { address: input.address, role: 'GUEST' },
    propertyId: input.propertyId,
    message: { type: 'TEXT', text: input.text },
    occurredAt: clock.now().toISOString(),
    correlationId: randomUUID(),
    idempotencyKey: `synthetic:${input.tenantId}:${input.conversationId}:${sha256(input.text)}`,
  });
}

export function verifyAuditChain(events: AuditEvent[]): boolean {
  if (events.length === 0) return true;
  return events.every((event, index) => {
    const expectedPrevious = index > 0 ? events[index - 1]!.payloadHash : undefined;
    if (event.previousHash !== expectedPrevious) return false;
    if (event.tenantId !== events[0]!.tenantId) return false;
    const { payloadHash: _payloadHash, previousHash: _previousHash, ...unsigned } = event;
    return event.payloadHash === auditDigest(unsigned);
  });
}

export async function runPlatformHarness(input: {
  event: CommunicationEvent;
  runtime: AgentRuntimeAdapter;
  agentId: string;
  capability: AgentCapability;
  context: Record<string, unknown>;
  clock?: HarnessClock;
}): Promise<HarnessResult> {
  const clock = input.clock ?? DEFAULT_CLOCK;
  if (input.event.tenantId !== input.context.tenantId) {
    throw new Error('tenant boundary violation: event and context tenant IDs differ');
  }

  const task: AgentTask = {
    id: randomUUID(),
    tenantId: input.event.tenantId,
    agentId: input.agentId,
    capabilityId: input.capability.id,
    input: { communicationEvent: input.event },
    contextEntityIds: Array.isArray(input.context.entityIds) ? input.context.entityIds.filter((v): v is string => typeof v === 'string') : [],
    correlationId: input.event.correlationId,
    createdAt: clock.now().toISOString(),
  };

  const audit: AuditEvent[] = [];
  const appendAudit = (eventType: string, actor: AuditEvent['actor'], payload: Record<string, unknown>, actionRequestId?: string) => {
    const previousHash = audit.at(-1)?.payloadHash;
    const unsigned = {
      id: randomUUID(),
      tenantId: input.event.tenantId,
      eventType,
      actor,
      correlationId: input.event.correlationId,
      actionRequestId,
      payload,
      occurredAt: clock.now().toISOString(),
      metadata: { harness: true },
    } satisfies Omit<AuditEvent, 'payloadHash' | 'previousHash'>;
    audit.push({ ...unsigned, payloadHash: auditDigest(unsigned), previousHash });
  };

  appendAudit('COMMUNICATION_RECEIVED', { kind: 'EXTERNAL', id: input.event.sender.address }, { eventId: input.event.id, channel: input.event.channel });
  appendAudit('AGENT_TASK_CREATED', { kind: 'SYSTEM', id: 'platform-harness' }, { taskId: task.id, agentId: task.agentId, capabilityId: task.capabilityId });

  const execution = await input.runtime.execute(task, input.context);
  appendAudit('AGENT_EXECUTION_COMPLETED', { kind: 'AGENT', id: input.agentId }, { executionId: execution.executionId, status: execution.status, output: execution.output });

  const decisions: HarnessDecision[] = [];
  for (const action of execution.actionRequests) {
    if (action.tenantId !== input.event.tenantId) throw new Error('tenant boundary violation: agent returned cross-tenant ActionRequest');
    const decision = evaluateActionPolicy(action, input.capability);
    decisions.push(decision);
    if (decision.decision === 'DENY') {
      appendAudit('ACTION_REJECTED_POLICY', { kind: 'SYSTEM', id: 'policy-engine' }, { reason: decision.reason, actionType: action.type }, action.id);
    } else if (decision.decision === 'REQUIRE_APPROVAL') {
      appendAudit('APPROVAL_REQUESTED', { kind: 'SYSTEM', id: 'policy-engine' }, { status: decision.action.status, riskLevel: action.riskLevel }, action.id);
    } else {
      appendAudit('ACTION_READY', { kind: 'SYSTEM', id: 'policy-engine' }, { status: decision.action.status, riskLevel: action.riskLevel }, action.id);
    }
  }

  if (!verifyAuditChain(audit)) throw new Error('audit chain verification failed');
  return { communicationEvent: input.event, task, execution, decisions, audit };
}
