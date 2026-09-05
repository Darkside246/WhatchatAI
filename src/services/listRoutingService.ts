import { queryAsTenant } from '../db/pool.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { ListAgentAssignmentRepository } from '../repositories/listAgentAssignmentRepository.js';
import { ListMemberRepository } from '../repositories/listMemberRepository.js';
import { routeInboundMessage, checkBlockedKeywordEscalation, type AgentRoutingDecision } from './agentRoutingService.js';
import { computeRelationshipSignal } from './relationshipConfidenceService.js';
import { ChatListEngagementRepository } from '../repositories/chatListEngagementRepository.js';

/**
 * Awaited (not fire-and-forget) - a single cheap upsert, negligible added
 * latency next to the several other DB round trips resolveAgentRouting
 * already makes, and awaiting it removes a real race a fire-and-forget
 * version had: an in-flight INSERT could still be running after this
 * function returned, colliding with anything (a test's resetDatabase()
 * TRUNCATE, a later request) that touches the same table concurrently.
 * Still never fatal to routing - a write failure here only logs, via the
 * same catch every other best-effort audit write in this codebase uses.
 */
async function recordEngagementBestEffort(businessId: string, chatId: string, listId: string): Promise<void> {
  await new ChatListEngagementRepository(queryAsTenant(businessId)).recordEngagement(businessId, chatId, listId).catch((error) => {
    console.error('[listRoutingService] Failed to record chat_list_engagement:', error instanceof Error ? error.message : error);
  });
}

/**
 * AURA Lists (Phase 1): routes a message via List assignment when the
 * chat has an unambiguous active List with an enabled agent, otherwise
 * falls through to the exact existing keyword+priority routing - a
 * business/chat that never uses Lists sees identical behavior to before
 * this file existed.
 *
 * Deliberately a new file, not a modification of agentRoutingService.ts's
 * routeInboundMessage - that function's own test suite is the proof its
 * behavior is unaffected by this feature.
 *
 * Order of decision:
 *  1. Blocked-keyword safety escalation - runs first, unconditionally.
 *     List assignment must never bypass a business's own safety
 *     configuration; this is the exact same check routeInboundMessage
 *     itself runs, via the shared checkBlockedKeywordEscalation helper.
 *  2. The chat's active_list_id, if set, resolved to an enabled
 *     list_agent_assignments row for an ACTIVE agent - routes there.
 *  3. Relationship-Confidence Engine (Phase 3): only when no active List
 *     is set AND the business has opted in (businesses.relationship_confidence_enabled) -
 *     a real, deterministic keyword-count suggestion for THIS message
 *     only (computeRelationshipSignal never writes active_list_id itself).
 *     Falls through when disabled, tied, or no real suggestion exists.
 *  4. Otherwise, the existing routeInboundMessage(businessId, messageText)
 *     unchanged - identical behavior to before either Lists or the
 *     Relationship-Confidence Engine existed.
 */
export async function resolveAgentRouting(businessId: string, chatId: string, messageText: string): Promise<AgentRoutingDecision> {
  const text = messageText.trim();
  if (!text) return { outcome: 'no_agent', reason: 'Inbound message has no real text to route on' };

  const agentRepository = new AiAgentRepository(queryAsTenant(businessId));
  const activeAgents = (await agentRepository.listByBusiness(businessId)).filter((agent) => agent.status === 'ACTIVE');
  const byPriority = activeAgents.slice().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  const escalation = checkBlockedKeywordEscalation(byPriority, text);
  if (escalation) return escalation;

  const chatRepository = new WhatsAppChatRepository(queryAsTenant(businessId));
  const chat = await chatRepository.findByIdForBusiness(chatId, businessId).catch(() => null);

  const assignmentRepository = new ListAgentAssignmentRepository(queryAsTenant(businessId));

  if (chat?.activeListId) {
    const assignment = await assignmentRepository.findEnabledForList(businessId, chat.activeListId).catch(() => null);
    if (assignment) {
      const agent = await agentRepository.findByIdForBusiness(assignment.agentId, businessId).catch(() => null);
      if (agent && agent.status === 'ACTIVE') {
        await recordEngagementBestEffort(businessId, chatId, chat.activeListId);
        return {
          outcome: 'route',
          agent,
          matchedKeyword: null,
          reason: `Routed via this chat's active List assignment`,
        };
      }
    }
  } else if (chat) {
    // No human-set active List - the Relationship-Confidence Engine may
    // offer a real, advisory suggestion for THIS message only (never
    // writes active_list_id itself). Fails closed to the exact existing
    // routing below whenever disabled, tied, or no real signal exists.
    const signal = await computeRelationshipSignal(businessId, chatId, text).catch(() => null);
    if (signal?.suggestedListId) {
      const assignment = await assignmentRepository.findEnabledForList(businessId, signal.suggestedListId).catch(() => null);
      if (assignment) {
        const agent = await agentRepository.findByIdForBusiness(assignment.agentId, businessId).catch(() => null);
        if (agent && agent.status === 'ACTIVE') {
          await recordEngagementBestEffort(businessId, chatId, signal.suggestedListId);
          return {
            outcome: 'route',
            agent,
            matchedKeyword: null,
            reason: `Routed via the Relationship-Confidence Engine's suggestion for this message`,
          };
        }
      }
    }
  }

  return routeInboundMessage(businessId, messageText);
}

/** Real, deterministic map from a chat's resolved Lists to which one (if any) should become the new active List. Returns the single candidate only when exactly one of the matched Lists has an enabled agent assignment - never guesses between two or more, per the directive's own "do not guess" rule (section 12). */
export async function computeUnambiguousActiveList(businessId: string, chatId: string): Promise<string | null> {
  const memberRepository = new ListMemberRepository(queryAsTenant(businessId));
  const assignmentRepository = new ListAgentAssignmentRepository(queryAsTenant(businessId));

  const lists = await memberRepository.resolveListsForChat(businessId, chatId);
  if (lists.length === 0) return null;

  const withEnabledAssignment: string[] = [];
  for (const list of lists) {
    const assignment = await assignmentRepository.findEnabledForList(businessId, list.id);
    if (assignment) withEnabledAssignment.push(list.id);
  }

  return withEnabledAssignment.length === 1 ? withEnabledAssignment[0]! : null;
}
