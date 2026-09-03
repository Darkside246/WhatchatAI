import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { BusinessRepository } from '../../repositories/businessRepository.js';
import { AiAgentRepository } from '../../repositories/aiAgentRepository.js';
import { pool } from '../../db/pool.js';
import { getToolPolicy, isToolRegistered, isTierAlwaysDenied, type AiToolRisk } from './aiToolPolicy.js';

export class UnregisteredToolError extends Error {}
export class UnknownTenantError extends Error {}
export class UnknownActorError extends Error {}
export class SystemTierToolDeniedError extends Error {}
export class ToolRateLimitExceededError extends Error {}
export class AiActionsPausedError extends Error {}
export class AgentAutonomyRestrictedError extends Error {}

export interface ToolInvocationContext {
  businessId: string;
  whatsappAccountId: string | null;
  chatId: string | null;
  agentId: string;
}

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const businessRepository = new BusinessRepository(pool);
const aiAgentRepository = new AiAgentRepository(pool);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read fresh on every call, deliberately - not frozen into a module-level
 * constant at import time, so an operator (or a test) changing the env can
 * take effect without a process restart.
 */
function getRateLimitWindowMinutes(): number {
  return envInt('AI_TOOL_RATE_LIMIT_WINDOW_MINUTES', 5);
}

/**
 * Per-risk-tier call ceiling within the rolling window above. Proportionate
 * to what actually exists today (one READ tool) rather than tuned against
 * real WRITE/SEND/HIGH_RISK traffic that has never run - generous enough
 * not to interrupt a real conversation, low enough to catch a genuine
 * runaway loop. Every number is env-overridable without a code change.
 */
function getRateLimit(risk: AiToolRisk): number {
  const limits: Record<AiToolRisk, number> = {
    READ: envInt('AI_TOOL_RATE_LIMIT_READ', 120),
    WRITE: envInt('AI_TOOL_RATE_LIMIT_WRITE', 30),
    SEND: envInt('AI_TOOL_RATE_LIMIT_SEND', 15),
    HIGH_RISK: envInt('AI_TOOL_RATE_LIMIT_HIGH_RISK', 5),
    SYSTEM: 0,
  };
  return limits[risk];
}

async function denyAndAudit(
  reasonPrefix: string,
  toolName: string,
  context: ToolInvocationContext,
  ErrorClass: new (message: string) => Error,
): Promise<never> {
  const message = `${reasonPrefix} (tool "${toolName}", agent ${context.agentId})`;
  await securityAuditLogRepository
    .record({
      businessId: context.businessId,
      whatsappAccountId: context.whatsappAccountId,
      eventType: 'ai_tool_denied',
      severity: 'critical',
      reason: message,
      rawMetadata: { toolName, chatId: context.chatId, agentId: context.agentId },
    })
    .catch((error) => {
      console.error('[AI Security Governor] Failed to write ai_tool_denied audit event:', error);
    });
  throw new ErrorClass(message);
}

/**
 * The AI Security Governor: the one gate every AI tool call passes
 * through before its result is trusted, and the gate any future
 * external-tool-execution surface (an OpenClaw-routed call included) must
 * pass through too - it does not depend on Gemini's native function
 * calling in any way. A real, multi-factor authorization pipeline, not
 * just a registry lookup:
 *
 *   1. Tool registered at all? (fails closed on a forged/unexpected name)
 *   2. SYSTEM-tier tool? Always denied - no code path grants a
 *      production conversation agent SYSTEM-tier execution, ever.
 *   3. Tenant real? (the businessId is checked against a live row, not
 *      merely trusted because the caller supplied one)
 *   4. Actor real? (the agentId must resolve to an ACTIVE agent that
 *      belongs to this exact business - closes the gap where a forged or
 *      cross-tenant agentId was previously only ever logged, never
 *      verified)
 *   5. Rate limit: a real, per-business-per-tool ceiling over a rolling
 *      window, tiered by risk (see RATE_LIMITS above).
 *
 * Every denial writes a real, visible `ai_tool_denied` audit event before
 * throwing - previously a rejection surfaced only as a generic
 * "unavailable" reply to the customer, with nothing in the operator's
 * security audit trail. A successful call still writes the existing
 * `ai_tool_invoked` event, unchanged.
 */
export async function guardToolInvocation(toolName: string, context: ToolInvocationContext): Promise<void> {
  if (!isToolRegistered(toolName)) {
    return denyAndAudit('AI attempted to invoke an unregistered tool', toolName, context, UnregisteredToolError);
  }

  const policy = getToolPolicy(toolName);
  const risk = policy?.risk ?? 'SYSTEM'; // Unreachable in practice (isToolRegistered just passed), but never assume a risk tier below the strictest if one is somehow missing.

  if (isTierAlwaysDenied(risk)) {
    return denyAndAudit(`SYSTEM-tier tools are never reachable from the production AI conversation path`, toolName, context, SystemTierToolDeniedError);
  }

  // A malformed id (not even a valid UUID) can never match a real row -
  // treated the same as "not found" rather than letting the query error
  // itself crash the call. Fail closed either way.
  const business = await businessRepository.findById(context.businessId).catch(() => null);
  if (!business) {
    return denyAndAudit('Tool invocation for an unknown business', toolName, context, UnknownTenantError);
  }

  // Emergency "Stop All Agents" kill switch (businesses.ai_actions_paused,
  // migration 952) - checked here, not just in aiReplyService's own
  // buildReplyTools filtering, because this is the one gate every tool
  // call passes through regardless of caller, so a future tool (an
  // OpenClaw-routed call included) can never accidentally skip it.
  // READ-tier tools stay available - "paused" means no action is taken,
  // not that the AI stops answering basic questions.
  if (business.aiActionsPaused && risk !== 'READ') {
    return denyAndAudit('AI actions are paused for this business', toolName, context, AiActionsPausedError);
  }

  const agent = await aiAgentRepository.findByIdForBusiness(context.agentId, context.businessId).catch(() => null);
  if (!agent || agent.status !== 'ACTIVE') {
    return denyAndAudit('Tool invocation from an unknown or cross-tenant agent', toolName, context, UnknownActorError);
  }

  // Autonomy level 1 ("read-only") - the authoritative enforcement of the
  // lowest rung of the 5-level ladder (migration 961). aiReplyService.ts's
  // buildReplyTools also filters the tool list down to READ for a level-1
  // agent so Gemini is never even offered one of these tools, but that is
  // purely an efficiency filter; this is the one gate every tool call
  // passes through regardless of caller, same reasoning as the
  // aiActionsPaused check above.
  if (agent.autonomyLevel === 1 && risk !== 'READ') {
    return denyAndAudit('Agent autonomy level is read-only', toolName, context, AgentAutonomyRestrictedError);
  }

  const windowMinutes = getRateLimitWindowMinutes();
  const recentCalls = await securityAuditLogRepository.countRecentByBusinessAndTool(context.businessId, toolName, windowMinutes);
  const limit = getRateLimit(risk);
  if (recentCalls >= limit) {
    return denyAndAudit(`Rate limit exceeded (${recentCalls}/${limit} in ${windowMinutes}m)`, toolName, context, ToolRateLimitExceededError);
  }

  await securityAuditLogRepository
    .record({
      businessId: context.businessId,
      whatsappAccountId: context.whatsappAccountId,
      eventType: 'ai_tool_invoked',
      severity: 'info',
      reason: `Tool "${toolName}" (${risk}) invoked by agent ${context.agentId}`,
      rawMetadata: { toolName, risk, chatId: context.chatId, agentId: context.agentId },
    })
    .catch((error) => {
      // Audit logging must never be the reason an otherwise-successful AI
      // reply fails to reach the customer - log the failure locally and
      // let the reply continue.
      console.error('[AI Security Governor] Failed to write ai_tool_invoked audit event:', error);
    });
}
