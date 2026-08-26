import { randomUUID } from 'node:crypto';
import type { ActionRequest, AgentCapability } from '../../domain/platform/contracts.js';
import { evaluateActionPolicy, type ActionPolicyDecision } from './actionPolicyService.js';
import { auditLedgerService } from './auditLedgerService.js';

export interface ActionExecutionContext {
  tenantId: string;
  actorId: string;
  signal?: AbortSignal;
}

export interface ActionExecutor {
  readonly actionType: string;
  execute(action: ActionRequest, context: ActionExecutionContext): Promise<{ status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string }>;
}

export class ActionBusService {
  private readonly executors = new Map<string, ActionExecutor>();
  private readonly completed = new Map<string, { status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string }>();

  register(executor: ActionExecutor): void {
    if (this.executors.has(executor.actionType)) throw new Error(`action executor ${executor.actionType} is already registered`);
    this.executors.set(executor.actionType, executor);
  }

  listExecutors(): string[] { return [...this.executors.keys()].sort(); }

  evaluate(action: ActionRequest, capability: AgentCapability): ActionPolicyDecision {
    return evaluateActionPolicy(action, capability);
  }

  async execute(
    action: ActionRequest,
    capability: AgentCapability,
    context: ActionExecutionContext,
  ): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'AWAITING_APPROVAL'; result?: unknown; error?: string }> {
    if (context.tenantId !== action.tenantId) return { status: 'DENIED', error: 'tenant context does not match action tenant' };
    if (context.actorId.length === 0) return { status: 'DENIED', error: 'execution actor is required' };

    const key = `${action.tenantId}:${action.idempotencyKey}`;
    const prior = this.completed.get(key);
    if (prior) return prior;

    const decision = evaluateActionPolicy(action, capability);
    auditLedgerService.append({
      id: randomUUID(),
      tenantId: action.tenantId,
      eventType: `ACTION_POLICY_${decision.decision}`,
      actor: { kind: action.requestedBy.kind === 'AGENT' ? 'AGENT' : action.requestedBy.kind === 'USER' ? 'USER' : 'SYSTEM', id: action.requestedBy.id },
      correlationId: action.correlationId,
      actionRequestId: action.id,
      payload: { actionType: action.type, riskLevel: action.riskLevel },
      occurredAt: new Date().toISOString(),
    });

    if (decision.decision === 'DENY') return { status: 'DENIED', error: decision.reason };
    if (decision.decision === 'REQUIRE_APPROVAL') return { status: 'AWAITING_APPROVAL', result: decision.action };

    const executor = this.executors.get(action.type);
    if (!executor) {
      auditLedgerService.append({
        id: randomUUID(), tenantId: action.tenantId, eventType: 'ACTION_EXECUTION_REJECTED',
        actor: { kind: 'SYSTEM', id: 'action-bus' }, correlationId: action.correlationId, actionRequestId: action.id,
        payload: { reason: 'no executor registered', actionType: action.type }, occurredAt: new Date().toISOString(),
      });
      return { status: 'DENIED', error: `no executor registered for ${action.type}` };
    }

    auditLedgerService.append({
      id: randomUUID(), tenantId: action.tenantId, eventType: 'ACTION_EXECUTION_STARTED',
      actor: { kind: 'SYSTEM', id: 'action-bus' }, correlationId: action.correlationId, actionRequestId: action.id,
      payload: { actionType: action.type }, occurredAt: new Date().toISOString(),
    });

    let result: { status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string };
    try {
      result = await executor.execute(decision.action, context);
    } catch (error) {
      result = { status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }

    auditLedgerService.append({
      id: randomUUID(), tenantId: action.tenantId, eventType: `ACTION_EXECUTION_${result.status}`,
      actor: { kind: 'SYSTEM', id: 'action-bus' }, correlationId: action.correlationId, actionRequestId: action.id,
      payload: { actionType: action.type, result: result.result, error: result.error }, occurredAt: new Date().toISOString(),
    });

    this.completed.set(key, result);
    return result;
  }
}

export const actionBusService = new ActionBusService();
