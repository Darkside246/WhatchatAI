import type { ActionRequest, AgentCapability } from '../../domain/platform/contracts.js';

export type ActionPolicyDecision =
  | { decision: 'DENY'; reason: string }
  | { decision: 'REQUIRE_APPROVAL'; action: ActionRequest; reason: string }
  | { decision: 'ALLOW'; action: ActionRequest };

const RISK_ORDER: Record<ActionRequest['riskLevel'], number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function evaluateActionPolicy(action: ActionRequest, capability: AgentCapability): ActionPolicyDecision {
  if (!action.tenantId) return { decision: 'DENY', reason: 'action has no tenant binding' };
  if (action.requestedBy.kind === 'AGENT' && action.requestedBy.id !== capability.agentId) {
    return { decision: 'DENY', reason: 'action requester does not match capability owner' };
  }
  if (capability.forbiddenActions.includes(action.type)) {
    return { decision: 'DENY', reason: `action "${action.type}" is explicitly forbidden by capability` };
  }
  if (!capability.allowedActions.includes(action.type)) {
    return { decision: 'DENY', reason: `action "${action.type}" is not allowed by capability` };
  }
  if (RISK_ORDER[action.riskLevel] > RISK_ORDER[capability.maxRiskLevel]) {
    return { decision: 'DENY', reason: `action risk ${action.riskLevel} exceeds capability maximum ${capability.maxRiskLevel}` };
  }

  const needsApproval = action.approval.required || capability.requiresApprovalFor.includes(action.type) || action.riskLevel === 'HIGH' || action.riskLevel === 'CRITICAL';
  if (needsApproval) {
    return {
      decision: 'REQUIRE_APPROVAL',
      action: { ...action, approval: { required: true, status: 'PENDING' }, status: 'PENDING_APPROVAL' },
      reason: capability.requiresApprovalFor.includes(action.type) || action.riskLevel !== 'LOW'
        ? 'capability or risk policy requires human approval'
        : 'action explicitly requires human approval',
    };
  }

  return { decision: 'ALLOW', action: { ...action, status: 'READY', approval: { required: false, status: 'NOT_REQUIRED' } } };
}
