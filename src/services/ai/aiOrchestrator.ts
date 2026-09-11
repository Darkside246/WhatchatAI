import { resolveEscalationAgent } from '../agentRoutingService.js';
import { resolveAgentRouting } from '../listRoutingService.js';
import { gatherAiHandoffContext } from '../aiContextGathererService.js';
import { generateAiReply } from '../aiReplyService.js';
import { runOutboundLeakGuard } from '../../security/sentinel/outboundLeakGuard.js';
import { stripTeamAddress } from './teamAddressGuard.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { BusinessMembershipRepository } from '../../repositories/businessMembershipRepository.js';
import { EntitlementService } from '../entitlementService.js';
import { pool } from '../../db/pool.js';
import type { AiAgentRecord } from '../../repositories/aiAgentRepository.js';
import type { AiHandoffContext } from '../aiContextGathererService.js';

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const entitlementService = new EntitlementService(pool);
const businessMembershipRepository = new BusinessMembershipRepository(pool);

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
  /**
   * code is a real, machine-readable discriminator for the handful of
   * 'unavailable' causes a caller needs to react to differently:
   *
   * - 'AI_BUDGET_EXCEEDED' (Section 34-40's real budget-override flow),
   *   which the worker uses to fire a distinct, once-per-month upsell
   *   notification instead of (or alongside) the generic AI_FAILURE
   *   hand-off notification every other cause gets.
   * - 'AI_PROVIDER_UNAVAILABLE', a TRANSIENT capacity/quota outage. The
   *   worker neither forces HUMAN_TAKEOVER (a state an operator would have
   *   to undo by hand once the provider recovers) nor raises the generic
   *   AI_FAILURE notification (which would repeat a raw provider error once
   *   per inbound message for the length of the outage). It still records
   *   the handoff-log entry, because a real customer message went
   *   unanswered. Set ONLY for self-recovering failures: an auth or
   *   provider_config fault must keep reaching an operator, since retrying
   *   cannot fix a bad key or a wrong model name.
   *
   * Never string-match `reason` for this - that's a human-facing
   * sentence, not a stable identifier.
   */
  | {
      kind: 'unavailable';
      agent: AiAgentRecord;
      reason: string;
      code?: 'AI_BUDGET_EXCEEDED' | 'AI_PROVIDER_UNAVAILABLE';
    }
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
  customerNameSources?: AiHandoffContext['contactNameSources'],
): Promise<{ kind: 'reply'; agent: AiAgentRecord; text: string } | { kind: 'blocked_leak'; agent: AiAgentRecord; reason: string }> {
  const guarded = await removeTeamAddress(businessId, text, customerNameSources ?? null);
  const verdict = await runOutboundLeakGuard(guarded, agent.protectedFacts);

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

  return { kind: 'reply', agent, text: guarded };
}

/**
 * Deletes a team member's name where the reply ADDRESSES them, before the
 * text goes anywhere near the customer. See teamAddressGuard.ts for the
 * production failure this exists for and for why only direct address is
 * touched - a mention of what a colleague said has to survive.
 *
 * Fails OPEN, deliberately. If the team cannot be listed (a DB blip), the
 * reply is sent unchanged rather than withheld: the prompt-level rule in
 * aiReplyService.ts is still in force, and the cost of a rare misdirected
 * greeting is much lower than the cost of silently dropping real replies
 * to real customers whenever this one query fails.
 */
async function removeTeamAddress(
  businessId: string,
  text: string,
  customerNameSources: AiHandoffContext['contactNameSources'],
): Promise<string> {
  try {
    const members = await businessMembershipRepository.listForBusiness(businessId);
    const teamNames = members.map((member) => member.displayName).filter((name) => name.trim().length > 0);
    if (teamNames.length === 0) return text;

    // Every name this customer is known by. A shared first name means the
    // guard does nothing for that name - see teamAddressGuard.ts.
    const customerNames = customerNameSources
      ? [
          customerNameSources.staffConfirmedName,
          customerNameSources.verifiedName,
          customerNameSources.businessName,
          customerNameSources.pushName,
          customerNameSources.username,
          customerNameSources.shortName,
        ].filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      : [];

    const result = stripTeamAddress(text, { teamNames, customerNames });
    if (result.removed.length === 0) return text;

    // The names that were removed, never the reply itself - the same
    // reasoning as blocked_leak's own "the text is deliberately not
    // carried on this outcome".
    await securityAuditLogRepository
      .record({
        businessId,
        whatsappAccountId: null,
        eventType: 'ai_output_team_address_removed',
        severity: 'warning',
        reason: `The reply addressed a team member (${result.removed.join(', ')}) rather than the customer; the direct address was removed before sending.`,
        rawMetadata: { removedNames: result.removed },
      })
      .catch((error) => {
        console.error('[teamAddressGuard] Failed to write ai_output_team_address_removed audit event:', error);
      });

    return result.text;
  } catch (error) {
    console.error('[teamAddressGuard] Could not check the reply for a team member address:', error instanceof Error ? error.message : error);
    return text;
  }
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
    resolveAgentRouting(input.businessId, input.chatId, input.queryText),
  ]);

  if (decision.outcome === 'no_agent') {
    return { kind: 'no_agent', reason: decision.reason };
  }
  if (decision.outcome === 'escalate_to_human') {
    return { kind: 'escalate_to_human', reason: decision.reason, matchedKeyword: decision.matchedKeyword };
  }

  const agent = decision.agent;

  // AURA Learn Agent auditability: only the audit trail needs to know
  // "which agent accessed this, when" - the actual gating already
  // happened (twice - see aiContextGathererService.ts and
  // buildSystemInstruction). Fire-and-forget: an audit-write failure
  // must never affect whether a reply gets generated.
  if (context.communicationStyle?.available && context.communicationStyle.profile && context.learnAllowedAgentIds.has(agent.id)) {
    void securityAuditLogRepository
      .record({
        businessId: input.businessId,
        eventType: 'writing_twin_context_served',
        rawMetadata: { agentId: agent.id, channelScope: context.communicationStyle.profile.channelScope, exampleCount: context.communicationStyle.profile.exampleCount },
      })
      .catch((error: Error) => console.error('[aiOrchestrator] Failed to record writing_twin_context_served:', error.message));
  }

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
    return budget.reason === 'ENTITLEMENT_LIMIT_REACHED'
      ? { kind: 'unavailable', agent, reason, code: 'AI_BUDGET_EXCEEDED' }
      : { kind: 'unavailable', agent, reason };
  }

  const reply = await generateAiReply(agent, context);

  if (reply.status === 'generated') {
    return guardGeneratedText(input.businessId, agent, reply.text, context.contactNameSources);
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
        return guardGeneratedText(input.businessId, escalationAgent, escalatedReply.text, context.contactNameSources);
      }
      return {
        kind: 'unavailable',
        agent: escalationAgent,
        reason: escalatedReply.reason,
        ...(escalatedReply.providerUnavailable ? { code: 'AI_PROVIDER_UNAVAILABLE' as const } : {}),
      };
    }
  }

  return {
    kind: 'unavailable',
    agent,
    reason: reply.reason,
    ...(reply.providerUnavailable ? { code: 'AI_PROVIDER_UNAVAILABLE' as const } : {}),
  };
}
