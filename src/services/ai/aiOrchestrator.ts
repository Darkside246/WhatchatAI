import { routeInboundMessage, resolveEscalationAgent } from '../agentRoutingService.js';
import { gatherAiHandoffContext } from '../aiContextGathererService.js';
import { generateAiReply } from '../aiReplyService.js';
import { runOutboundLeakGuard } from '../../security/sentinel/outboundLeakGuard.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { EntitlementService } from '../entitlementService.js';
import { pool } from '../../db/pool.js';
import type { AiAgentRecord } from '../../repositories/aiAgentRepository.js';

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const entitlementService = new EntitlementService(pool);

export interface OrchestrateAiReplyInput {
  businessId: string;
  chatId: string;
  contactId: string | null;
  queryText: string;
  /** The triggering message's media row, when it has real, already-downloaded media the AI should actually see/hear. */
  mediaId?: string | null;
}

export type OrchestratedAiOutcome =
  | { kind: 'no_agent'; reason: string }
  | { kind: 'escalate_to_human'; reason: string; matchedKeyword: string }
  | { kind: 'reply'; agent: AiAgentRecord; text: string }
  | { kind: 'unavailable'; agent: AiAgentRecord; reason: string }
  /**
   * A real reply was generated but the Outbound Leak Guard blocked it
   * before it ever left this process - the (leaked) text is deliberately
   * not carried on this outcome, only the reason, so it can never
   * accidentally be logged or displayed downstream.
   */
  | { kind: 'blocked_leak'; agent: AiAgentRecord; reason: string };

/**
 * Runs every generated reply through the Outbound Leak Guard before it is
 * trusted - the one place this check happens, so it can never be bypassed
 * by a future caller of orchestrateAiReply. A block writes a real
 * security_audit_logs row (mirrors the shape agentGuard.ts already uses
 * for AI tool denials) before the caller ever sees it.
 */
/** Exported for direct testing (test/aiOrchestratorOutboundGuard.test.ts) - exercising the full orchestrateAiReply path needs a real Gemini call to reach 'generated', which this environment has no key for; this is the one real seam that lets the audit-log-writing/outcome-shape wiring be tested honestly without faking a model response. */
export async function guardGeneratedText(
  businessId: string,
  agent: AiAgentRecord,
  text: string,
): Promise<{ kind: 'reply'; agent: AiAgentRecord; text: string } | { kind: 'blocked_leak'; agent: AiAgentRecord; reason: string }> {
  const verdict = await runOutboundLeakGuard(text, agent.protectedFacts);

  if (!verdict.allowed) {
    await securityAuditLogRepository
      .record({
        businessId,
        whatsappAccountId: null,
        eventType: verdict.eventType,
        severity: 'critical',
        reason: verdict.reason,
        rawMetadata: { agentId: agent.id },
      })
      .catch((error) => {
        console.error('[Outbound Leak Guard] Failed to write ai_output_leak_blocked audit event:', error);
      });
    return { kind: 'blocked_leak', agent, reason: verdict.reason ?? 'Blocked: would have disclosed a protected fact' };
  }

  if (verdict.eventType === 'ai_output_leak_check_unavailable') {
    await securityAuditLogRepository
      .record({
        businessId,
        whatsappAccountId: null,
        eventType: verdict.eventType,
        severity: 'warning',
        reason: verdict.reason,
        rawMetadata: { agentId: agent.id },
      })
      .catch((error) => {
        console.error('[Outbound Leak Guard] Failed to write ai_output_leak_check_unavailable audit event:', error);
      });
  }

  return { kind: 'reply', agent, text };
}

/**
 * The single entry point that centralizes "which agent, given what
 * context, says what" - replacing what used to be three services
 * (routeInboundMessage, gatherAiHandoffContext, generateAiReply) called
 * separately and stitched together inline in the incoming-messages queue
 * worker. Every side effect that follows a decision - notifications,
 * ai_mode transitions, the actual outbound send - stays in the caller,
 * since those are queue/dispatch concerns, not AI orchestration ones:
 * this function's job ends at "here is what the AI decided," never "and
 * here is what happened to the chat as a result." Preserves the exact
 * same routing/escalation/context logic that existed before this phase -
 * a consolidation, not a rewrite.
 */
export async function orchestrateAiReply(input: OrchestrateAiReplyInput): Promise<OrchestratedAiOutcome> {
  const [context, decision] = await Promise.all([
    gatherAiHandoffContext({
      businessId: input.businessId,
      chatId: input.chatId,
      contactId: input.contactId,
      queryText: input.queryText,
      mediaId: input.mediaId ?? null,
    }),
    routeInboundMessage(input.businessId, input.queryText),
  ]);

  if (decision.outcome === 'no_agent') {
    return { kind: 'no_agent', reason: decision.reason };
  }
  if (decision.outcome === 'escalate_to_human') {
    return { kind: 'escalate_to_human', reason: decision.reason, matchedKeyword: decision.matchedKeyword };
  }

  const agent = decision.agent;

  // Real cost-control gate (Section 34-40) - checked once per inbound
  // message, right before the one real Gemini call that actually costs
  // money, never after. 'unavailable' is the same honest hand-off-to-human
  // outcome an out-of-credentials or provider-down failure already
  // produces (see generateAiReply's own 'unavailable' branch) - the worker
  // that consumes this outcome already hands the chat to a human and
  // notifies the business with zero further wiring needed here.
  //
  // Blocks on NO_ACTIVE_SUBSCRIPTION too, consistent with every other real
  // entitlement check (canCreateAgent, canConnectWhatsAppAccount, etc.) -
  // in production a business always has one the moment it exists
  // (ensureDefaultBusinessProvisioned / trialOnboardingService.ts's own
  // subscription insert), so this only fires for a genuinely-expired,
  // never-converted trial once subscriptionExpiryService.ts's sweep marks
  // it EXPIRED. Before Section 72's sweep existed, a TRIALING subscription
  // never actually expired in practice, so this case was untested and
  // easy to get wrong by exempting it - it no longer is.
  const budget = await entitlementService.canUseAiThisMonth(input.businessId);
  if (!budget.allowed) {
    const reason =
      budget.reason === 'ENTITLEMENT_LIMIT_REACHED'
        ? `This business has used its full AI reply allowance for this billing month (limit: ${budget.limit ?? 'unknown'} tokens).`
        : budget.reason === 'ENTITLEMENT_DISABLED'
          ? 'This plan does not include AI replies.'
          : 'This business has no active subscription.';
    return { kind: 'unavailable', agent, reason };
  }

  const reply = await generateAiReply(agent, context);

  if (reply.status === 'generated') {
    return guardGeneratedText(input.businessId, agent, reply.text);
  }

  // A real escalation hop: if the selected agent could not produce a
  // reply and the operator configured someone to escalate to, try that
  // agent once. Exactly one hop - never a chain that could loop between
  // two agents pointing at each other. Phase 3B: only attempted when the
  // failure reason is one a *different* agent's own configuration could
  // plausibly avoid (reply.skipEscalation is false) - a capacity/auth/
  // provider-config/programming failure is agent-independent, and
  // immediately repeating an identical call against a second agent would
  // almost certainly fail identically, wasting a real call for nothing
  // (see docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 2/5).
  if (!reply.skipEscalation) {
    const escalationAgent = await resolveEscalationAgent(agent);
    if (escalationAgent) {
      const escalatedReply = await generateAiReply(escalationAgent, context);
      if (escalatedReply.status === 'generated') {
        return guardGeneratedText(input.businessId, escalationAgent, escalatedReply.text);
      }
      return { kind: 'unavailable', agent: escalationAgent, reason: escalatedReply.reason };
    }
  }

  return { kind: 'unavailable', agent, reason: reply.reason };
}
