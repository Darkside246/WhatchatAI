import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { pool } from '../../db/pool.js';
import { getToolPolicy, isToolRegistered } from './aiToolPolicy.js';

export class UnregisteredToolError extends Error {}

export interface ToolInvocationContext {
  businessId: string;
  whatsappAccountId: string | null;
  chatId: string | null;
  agentId: string;
}

/**
 * The one gate every AI tool call passes through before its result is
 * trusted. Fails closed on an unregistered tool name - defense in depth,
 * since the SDK only ever offers the model tools this codebase
 * explicitly declared, but a forged or unexpected tool name in a model
 * response is rejected here rather than executed on faith - and always
 * writes a real, non-PII audit event (never message text, contact names,
 * or phone numbers - structural/diagnostic context only, matching the
 * same rule `securityAlertService.ts` already documents for its own
 * Zero-Leak audit surface).
 */
export async function guardToolInvocation(toolName: string, context: ToolInvocationContext): Promise<void> {
  if (!isToolRegistered(toolName)) {
    throw new UnregisteredToolError(`AI attempted to invoke unregistered tool "${toolName}"`);
  }

  const policy = getToolPolicy(toolName);
  await new SecurityAuditLogRepository(pool)
    .record({
      businessId: context.businessId,
      whatsappAccountId: context.whatsappAccountId,
      eventType: 'ai_tool_invoked',
      severity: 'info',
      reason: `Tool "${toolName}" (${policy?.risk ?? 'UNKNOWN'}) invoked by agent ${context.agentId}`,
      rawMetadata: { toolName, risk: policy?.risk ?? null, chatId: context.chatId, agentId: context.agentId },
    })
    .catch((error) => {
      // Audit logging must never be the reason an otherwise-successful AI
      // reply fails to reach the customer - log the failure locally and
      // let the reply continue.
      console.error('[agentGuard] Failed to write ai_tool_invoked audit event:', error);
    });
}
