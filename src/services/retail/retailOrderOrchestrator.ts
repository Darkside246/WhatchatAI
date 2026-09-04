import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { ProductAccountRepository } from '../../repositories/productAccountRepository.js';
import { RetailOperationsRepository } from '../../repositories/retailOperationsRepository.js';
import { PlatformActionRepository } from '../../repositories/platformActionRepository.js';
import { RetailContextService } from './retailContextService.js';
import { RetailTriageFeedbackRepository } from '../../repositories/retailTriageFeedbackRepository.js';
import { ApprovalService } from '../platform/approvalService.js';
import { runRetailOrderTriage } from './retailAgentService.js';
import { skillRegistry, retailOrderTriageSkill } from '../platform/skillRegistry.js';
import { auditLedgerService } from '../platform/auditLedgerService.js';
import { notifyBusiness } from '../notificationService.js';
import type { CommunicationEvent } from '../../domain/platform/contracts.js';

const productAccountRepository = new ProductAccountRepository(pool);
const retailRepository = new RetailOperationsRepository(pool);
const contextService = new RetailContextService(retailRepository);
const feedbackRepo = new RetailTriageFeedbackRepository(pool);
const approvalService = new ApprovalService(pool);
const actionRepository = new PlatformActionRepository(pool);

export type RetailOrderHandoffResult =
  | { kind: 'not_applicable' }
  | { kind: 'handled'; replyText: string | null };

/**
 * Runs ahead of the generic AI reply for any business with an operational
 * retail product account - the same WhatsApp -> triage -> ActionRequest ->
 * approval -> order -> audit loop propertyMaintenanceOrchestrator.ts runs
 * for property, but gated differently: property gates on a per-chat
 * binding (which property does this conversation belong to), while retail
 * has nothing to disambiguate (one flat catalog per business) and instead
 * gates on "does this business actually have retail operations enabled" -
 * requiring a customer to be pre-bound before "I'd like to order 2 shirts"
 * works would be a real UX regression versus property's guest-preassigned
 * model.
 */
export async function runRetailOrderHandoff(params: {
  businessId: string;
  chatId: string;
  conversationAddress: string;
  queryText: string;
}): Promise<RetailOrderHandoffResult> {
  const skill = skillRegistry.get(retailOrderTriageSkill.id);
  if (!skill?.enabled) return { kind: 'not_applicable' };

  const account = await productAccountRepository.findByBusinessAndProduct(params.businessId, 'retail').catch(() => null);
  if (!account || account.status !== 'ACTIVE') return { kind: 'not_applicable' };

  const context = await contextService.build({ businessId: params.businessId });

  const correlationId = randomUUID();
  const event: CommunicationEvent = {
    id: randomUUID(),
    tenantId: params.businessId,
    channel: 'WHATSAPP',
    conversationId: params.chatId,
    sender: { address: params.conversationAddress, role: 'GUEST' },
    message: { type: 'TEXT', text: params.queryText },
    occurredAt: new Date().toISOString(),
    correlationId,
    idempotencyKey: `retail-handoff:${params.businessId}:${params.chatId}:${correlationId}`,
  };

  const result = await runRetailOrderTriage({
    event,
    context,
    agentId: 'retail-order-triage',
    feedbackRepo,
  });

  // Same dedup-and-audit shape as propertyMaintenanceOrchestrator.ts: an
  // open action of the same type on this same chat absorbs repeat messages
  // instead of re-triaging and multiplying ActionRequests/approval prompts.
  let hadOpenDuplicate = false;
  let duplicateSummary: string | null = null;
  for (const action of result.actionRequests) {
    const existing = await actionRepository.findOpenByConversation(params.businessId, params.chatId, action.type).catch((err: unknown) => {
      console.error('[RetailOrderOrchestrator] Failed to check for an open duplicate action:', err instanceof Error ? err.message : err);
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
      console.error('[RetailOrderOrchestrator] Failed to persist action:', err instanceof Error ? err.message : err);
    }

    auditLedgerService.append({
      id: randomUUID(),
      tenantId: params.businessId,
      eventType: 'RETAIL_ORDER_ACTION_CREATED',
      actor: { kind: 'AGENT', id: 'retail-order-triage' },
      correlationId,
      actionRequestId: action.id,
      payload: { actionType: action.type, riskLevel: action.riskLevel, approvalRequired: action.approval.required },
      occurredAt: new Date().toISOString(),
    });

    if (!action.approval.required) {
      const summary = typeof action.payload.summary === 'string' ? action.payload.summary : `${action.type} (${action.riskLevel})`;
      await notifyBusiness({
        businessId: params.businessId,
        type: 'HUMAN_HANDOFF',
        severity: action.riskLevel === 'CRITICAL' || action.riskLevel === 'HIGH' ? 'critical' : 'warning',
        title: 'Retail order needs human review',
        body: summary,
        targetType: 'chat',
        targetId: params.chatId,
      }).catch((err) => {
        console.error('[RetailOrderOrchestrator] notifyBusiness failed:', err instanceof Error ? err.message : err);
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
