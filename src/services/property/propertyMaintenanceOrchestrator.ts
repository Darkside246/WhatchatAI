import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { PropertyConversationBindingRepository } from '../../repositories/propertyConversationBindingRepository.js';
import { PropertyOperationsRepository } from '../../repositories/propertyOperationsRepository.js';
import { PlatformActionRepository } from '../../repositories/platformActionRepository.js';
import { PropertyContextService } from './propertyContextService.js';
import { TriageFeedbackRepository } from '../../repositories/triageFeedbackRepository.js';
import { ApprovalService } from '../platform/approvalService.js';
import { runPropertyMaintenanceTriage } from './propertyMaintenanceAgentService.js';
import { skillRegistry, propertyMaintenanceTriageSkill } from '../platform/skillRegistry.js';
import { auditLedgerService } from '../platform/auditLedgerService.js';
import { notifyBusiness } from '../notificationService.js';
import type { CommunicationEvent } from '../../domain/platform/contracts.js';

const bindingRepository = new PropertyConversationBindingRepository(pool);
const propertyRepository = new PropertyOperationsRepository(pool);
const contextService = new PropertyContextService(propertyRepository);
const feedbackRepo = new TriageFeedbackRepository(pool);
const approvalService = new ApprovalService(pool);
const actionRepository = new PlatformActionRepository(pool);

export type PropertyMaintenanceHandoffResult =
  | { kind: 'not_applicable' }
  | { kind: 'handled'; replyText: string | null };

/**
 * Runs ahead of the generic AI reply for any chat an operator has bound to
 * a property (see propertyConversationBindingRouter). Completes the WhatsApp
 * -> triage -> ActionRequest -> approval -> work order -> audit loop for the
 * property vertical without touching the ordinary aiOrchestrator path for
 * every other business - returns 'not_applicable' the moment there's no
 * binding or the skill is off, and the caller falls through unchanged.
 */
export async function runPropertyMaintenanceHandoff(params: {
  businessId: string;
  chatId: string;
  conversationAddress: string;
  queryText: string;
}): Promise<PropertyMaintenanceHandoffResult> {
  const skill = skillRegistry.get(propertyMaintenanceTriageSkill.id);
  if (!skill?.enabled) return { kind: 'not_applicable' };

  const binding = await bindingRepository.get(params.businessId, params.chatId);
  if (!binding) return { kind: 'not_applicable' };

  const context = await contextService.build({
    businessId: params.businessId,
    propertyId: binding.propertyId,
    ...(binding.unitId ? { unitId: binding.unitId } : {}),
  });

  const correlationId = randomUUID();
  const event: CommunicationEvent = {
    id: randomUUID(),
    tenantId: params.businessId,
    channel: 'WHATSAPP',
    conversationId: params.chatId,
    sender: { address: params.conversationAddress, role: 'GUEST' },
    propertyId: binding.propertyId,
    message: { type: 'TEXT', text: params.queryText },
    occurredAt: new Date().toISOString(),
    correlationId,
    idempotencyKey: `property-handoff:${params.businessId}:${params.chatId}:${correlationId}`,
  };

  const result = await runPropertyMaintenanceTriage({
    event,
    context,
    agentId: 'property-maintenance-triage',
    feedbackRepo,
  });

  // Persist and audit every action this produced, not only the
  // approval-required ones. A deterministic life-safety escalation or an
  // AI-recommended ESCALATE_HUMAN both carry approvalRequired=false (see
  // propertyMaintenanceAgentService.ts) - previously only approval-gated
  // actions reached the approvals table, so those cases vanished with
  // nothing but a server log line.
  //
  // Deduped against any still-open action of the same type on this same
  // chat before persisting: without this, a tenant asking "is anyone
  // coming?" three times about one unresolved leak re-triages three times
  // and creates three separate ActionRequests/approval prompts for the
  // same issue, since each triage call used to mint a fresh idempotency
  // key off a fresh correlationId. One open action per (chat, type) now
  // absorbs repeats instead of multiplying them.
  let hadOpenDuplicate = false;
  let duplicateSummary: string | null = null;
  for (const action of result.actionRequests) {
    const existing = await actionRepository.findOpenByConversation(params.businessId, params.chatId, action.type).catch((err: unknown) => {
      console.error('[PropertyMaintenanceOrchestrator] Failed to check for an open duplicate action:', err instanceof Error ? err.message : err);
      return null;
    });
    if (existing) {
      hadOpenDuplicate = true;
      const payload = existing.payload as Record<string, unknown>;
      duplicateSummary = typeof payload.summary === 'string' ? payload.summary : null;
      continue;
    }

    try {
      await approvalService.persistAction(action);
    } catch (err) {
      console.error('[PropertyMaintenanceOrchestrator] Failed to persist action:', err instanceof Error ? err.message : err);
    }

    auditLedgerService.append({
      id: randomUUID(),
      tenantId: params.businessId,
      eventType: 'MAINTENANCE_ACTION_CREATED',
      actor: { kind: 'AGENT', id: 'property-maintenance-triage' },
      correlationId,
      actionRequestId: action.id,
      payload: { actionType: action.type, riskLevel: action.riskLevel, approvalRequired: action.approval.required },
      occurredAt: new Date().toISOString(),
    });

    if (!action.approval.required) {
      const summary = typeof action.payload.summary === 'string' ? action.payload.summary : `${action.type} (${action.riskLevel})`;
      await notifyBusiness({
        businessId: params.businessId,
        type: action.riskLevel === 'CRITICAL' ? 'AI_FAILURE' : 'HUMAN_HANDOFF',
        severity: action.riskLevel === 'CRITICAL' ? 'critical' : 'warning',
        title: action.type === 'maintenance.contact_emergency_service' ? 'Emergency service contact needed' : 'Maintenance issue needs human review',
        body: summary,
        targetType: 'chat',
        targetId: params.chatId,
      }).catch((err) => {
        console.error('[PropertyMaintenanceOrchestrator] notifyBusiness failed:', err instanceof Error ? err.message : err);
      });
    }
  }

  if (result.replyGuidance.length > 0) {
    return { kind: 'handled', replyText: result.replyGuidance.join('\n') };
  }
  if (hadOpenDuplicate) {
    return {
      kind: 'handled',
      replyText: duplicateSummary
        ? `This is already with our team (${duplicateSummary}) - they've been notified and will follow up shortly.`
        : "This is already with our team - they've been notified and will follow up shortly.",
    };
  }
  return { kind: 'handled', replyText: null };
}
