import { pool } from '../db/pool.js';
import { AiAgentRepository, type AiAgentRecord } from '../repositories/aiAgentRepository.js';

const agentRepository = new AiAgentRepository(pool);

export type AgentRoutingDecision =
  /** A real agent was selected and may generate a reply. */
  | { outcome: 'route'; agent: AiAgentRecord; matchedKeyword: string | null; reason: string }
  /** A blocked keyword matched - no AI reply may be sent, a human must take this. */
  | { outcome: 'escalate_to_human'; agent: AiAgentRecord; matchedKeyword: string; reason: string }
  /** Nothing to route to. Never a fabricated fallback agent. */
  | { outcome: 'no_agent'; reason: string };

/**
 * Case-insensitive whole-word-ish containment. Deliberately not a substring
 * test: "art" must not match "start", or a business would get silent,
 * baffling escalations. Punctuation and spacing around the keyword are fine.
 */
function matchesKeyword(text: string, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}

function firstMatch(text: string, keywords: string[]): string | null {
  for (const keyword of keywords) {
    if (matchesKeyword(text, keyword)) return keyword;
  }
  return null;
}

/**
 * Picks which of a business's active agents should handle a real inbound
 * message, using the configuration the operator actually set.
 *
 * Order of decision, and why:
 *  1. Blocked keywords win over everything. If ANY active agent declares a
 *     blocked keyword that matches, no AI reply is sent at all. A business
 *     that marks "refund" or "legal" as blocked means it on the whole
 *     account, not just for one agent - the safe reading of that config is
 *     the restrictive one.
 *  2. Trigger keywords, highest priority first. This is the specific,
 *     intentional match.
 *  3. A general-purpose agent (one with no trigger keywords) as the catch
 *     all, highest priority first.
 *
 * Returns 'no_agent' rather than inventing a fallback when nothing applies -
 * the caller must skip silently, never fabricate a reply.
 */
export async function routeInboundMessage(businessId: string, messageText: string): Promise<AgentRoutingDecision> {
  const agents = (await agentRepository.listByBusiness(businessId)).filter((agent) => agent.status === 'ACTIVE');
  if (agents.length === 0) return { outcome: 'no_agent', reason: 'No active AI agent is configured for this business' };

  const text = messageText.trim();
  if (!text) return { outcome: 'no_agent', reason: 'Inbound message has no real text to route on' };

  const byPriority = agents.slice().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  for (const agent of byPriority) {
    const blocked = firstMatch(text, agent.blockedKeywords);
    if (blocked) {
      return {
        outcome: 'escalate_to_human',
        agent,
        matchedKeyword: blocked,
        reason: `Blocked keyword "${blocked}" matched - handing to a human instead of replying`,
      };
    }
  }

  for (const agent of byPriority) {
    const triggered = firstMatch(text, agent.triggerKeywords);
    if (triggered) {
      return {
        outcome: 'route',
        agent,
        matchedKeyword: triggered,
        reason: `Trigger keyword "${triggered}" matched agent "${agent.name}"`,
      };
    }
  }

  const generalist = byPriority.find((agent) => agent.triggerKeywords.length === 0);
  if (generalist) {
    return {
      outcome: 'route',
      agent: generalist,
      matchedKeyword: null,
      reason: `No keyword matched - using general-purpose agent "${generalist.name}"`,
    };
  }

  return {
    outcome: 'no_agent',
    reason: 'Every active agent is keyword-scoped and none matched, and no general-purpose agent exists',
  };
}

/**
 * The real escalation target for an agent that could not answer. Only
 * returns an agent that genuinely exists, is active, and belongs to the same
 * business - a dangling or cross-tenant link resolves to null rather than
 * silently routing somewhere unexpected.
 */
export async function resolveEscalationAgent(agent: AiAgentRecord): Promise<AiAgentRecord | null> {
  if (!agent.escalateToAgentId) return null;
  const target = await agentRepository.findById(agent.escalateToAgentId);
  if (!target || target.deletedAt || target.status !== 'ACTIVE') return null;
  if (target.businessId !== agent.businessId) return null;
  return target;
}
