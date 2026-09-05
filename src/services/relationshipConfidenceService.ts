/**
 * Relationship-Confidence Engine (Phase 3) - an advisory-only signal for
 * the genuinely ambiguous case Lists Phase 1 deliberately left as a safe
 * "never guess" null (listRoutingService.ts's computeUnambiguousActiveList).
 * Deterministic keyword-count scoring only, reusing
 * agentRoutingService.ts's own countMatchedKeywords against each
 * candidate List's assigned agent's own configured triggerKeywords -
 * never an LLM call, never a fabricated confidence float.
 *
 * This service NEVER writes whatsapp_chats.active_list_id itself - that
 * column stays exclusively human-set (see listsService.ts's
 * setActiveList), preserving Lists Phase 1's own non-destructive
 * guarantee. Its only write is chat_relationship_signals, a real-time,
 * always-current suggestion a human can see and act on, never a silent
 * permanent decision.
 */

import { queryAsTenant } from '../db/pool.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { ListMemberRepository } from '../repositories/listMemberRepository.js';
import { ListAgentAssignmentRepository } from '../repositories/listAgentAssignmentRepository.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';
import { ChatRelationshipSignalRepository, type ChatRelationshipSignalRecord, type RelationshipCandidate } from '../repositories/chatRelationshipSignalRepository.js';
import { ChatListEngagementRepository } from '../repositories/chatListEngagementRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { countMatchedKeywords } from './agentRoutingService.js';
import { pool } from '../db/pool.js';

/**
 * Engagement-history follow-up: recency/frequency is a TIEBREAKER only,
 * never a standalone signal. Only consulted when keyword matching alone
 * produced a genuine tie (including an all-zero tie) among the top-scoring
 * candidates - a real, deterministic keyword winner is never overridden by
 * engagement history. Returns null (never guesses) unless exactly one tied
 * candidate has a strictly more recent lastActiveAt than every other tied
 * candidate; "never engaged" (no row at all) always loses to "engaged at
 * some point," but two never-engaged or two equally-stale candidates stay
 * tied - real evidence or nothing.
 */
function breakTieByRecency(tiedCandidates: RelationshipCandidate[]): string | null {
  const withEngagement = tiedCandidates.filter((c) => c.lastActiveAt);
  if (withEngagement.length === 0) return null;

  const sorted = withEngagement.slice().sort((a, b) => new Date(b.lastActiveAt!).getTime() - new Date(a.lastActiveAt!).getTime());
  const mostRecent = sorted[0]!;
  const secondMostRecentTime = sorted[1] ? new Date(sorted[1].lastActiveAt!).getTime() : -Infinity;
  const mostRecentTime = new Date(mostRecent.lastActiveAt!).getTime();

  return mostRecentTime > secondMostRecentTime ? mostRecent.listId : null;
}

/**
 * Fails closed on every real-world edge: disabled business, no candidates,
 * a tie, or an all-zero score all return null / no suggestion - the same
 * "never guess" discipline computeUnambiguousActiveList already
 * established. Never throws; a lookup failure degrades to null.
 */
export async function computeRelationshipSignal(businessId: string, chatId: string, messageText: string): Promise<ChatRelationshipSignalRecord | null> {
  const businessRepository = new BusinessRepository(pool);
  const business = await businessRepository.findById(businessId).catch(() => null);
  if (!business?.relationshipConfidenceEnabled) return null;

  const memberRepository = new ListMemberRepository(queryAsTenant(businessId));
  const lists = await memberRepository.resolveListsForChat(businessId, chatId).catch(() => []);
  if (lists.length < 2) return null; // not actually ambiguous - nothing to score

  const assignmentRepository = new ListAgentAssignmentRepository(queryAsTenant(businessId));
  const agentRepository = new AiAgentRepository(queryAsTenant(businessId));

  const candidates: RelationshipCandidate[] = [];
  for (const list of lists) {
    const assignment = await assignmentRepository.findEnabledForList(businessId, list.id).catch(() => null);
    if (!assignment) continue;
    const agent = await agentRepository.findByIdForBusiness(assignment.agentId, businessId).catch(() => null);
    if (!agent || agent.status !== 'ACTIVE') continue;

    const matchedKeywords = countMatchedKeywords(messageText, agent.triggerKeywords);
    candidates.push({
      listId: list.id, listName: list.name, agentId: agent.id, agentName: agent.name,
      matchedKeywords, score: matchedKeywords.length,
    });
  }

  if (candidates.length < 2) return null; // fewer than 2 candidates actually have an enabled, active agent - not a real choice

  // Engagement history is attached to every candidate (for real
  // transparency in the UI, whether or not it ends up deciding anything),
  // fetched once regardless of whether keyword scoring alone already has
  // a clear winner.
  const engagementRepository = new ChatListEngagementRepository(queryAsTenant(businessId));
  const engagements = await engagementRepository.getEngagementForCandidates(businessId, chatId, candidates.map((c) => c.listId)).catch(() => []);
  const engagementByListId = new Map(engagements.map((e) => [e.listId, e]));
  for (const candidate of candidates) {
    const engagement = engagementByListId.get(candidate.listId);
    if (engagement) {
      candidate.lastActiveAt = engagement.lastActiveAt;
      candidate.engagementCount = engagement.engagementCount;
    }
  }

  // A real winner only when exactly one candidate strictly beats every
  // other on keyword score - a tie (including an all-zero tie) falls
  // through to the recency tiebreak above, never guessed outright.
  const maxScore = Math.max(...candidates.map((c) => c.score));
  const topCandidates = candidates.filter((c) => c.score === maxScore);
  const suggestedListId =
    maxScore > 0 && topCandidates.length === 1
      ? topCandidates[0]!.listId
      : breakTieByRecency(topCandidates);

  const chatRelationshipSignalRepository = new ChatRelationshipSignalRepository(queryAsTenant(businessId));
  const signal = await chatRelationshipSignalRepository.upsert({ businessId, chatId, candidates, suggestedListId });

  const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
  await securityAuditLogRepository
    .record({ businessId, eventType: 'relationship_suggestion_computed', rawMetadata: { chatId, suggestedListId, candidateCount: candidates.length } })
    .catch((error) => console.error('[relationshipConfidenceService] Failed to record relationship_suggestion_computed audit event:', error instanceof Error ? error.message : error));

  return signal;
}
