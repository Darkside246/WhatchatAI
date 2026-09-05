import { pool, queryAsTenant } from '../db/pool.js';
import { ListRepository, type ListRecord, type CreateListInput, type UpdateListInput } from '../repositories/listRepository.js';
import { ListMemberRepository, type ListMemberRecord, type ListMemberType } from '../repositories/listMemberRepository.js';
import { ListAgentAssignmentRepository, type ListAgentAssignmentRecord, type UpsertListAgentAssignmentInput } from '../repositories/listAgentAssignmentRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { ChatRelationshipSignalRepository, type ChatRelationshipSignalRecord } from '../repositories/chatRelationshipSignalRepository.js';
import { ChatListEngagementRepository } from '../repositories/chatListEngagementRepository.js';
import { computeUnambiguousActiveList } from './listRoutingService.js';

/**
 * AURA Lists (Phase 1): the thin service layer behind the /api/workspace/lists*
 * routes - wraps the repositories with the standard audit-log writes every
 * other mutating feature this session already follows (Business
 * Intelligence, Learn). Never called from anywhere in the AI reply path
 * itself - that's listRoutingService.ts/aiContextGathererService.ts's job.
 */

export async function listLists(businessId: string): Promise<ListRecord[]> {
  return new ListRepository(queryAsTenant(businessId)).listByBusiness(businessId);
}

export async function createList(input: CreateListInput): Promise<ListRecord> {
  const list = await new ListRepository(queryAsTenant(input.businessId)).create(input);
  await new SecurityAuditLogRepository(queryAsTenant(input.businessId))
    .record({ businessId: input.businessId, eventType: 'list_created', rawMetadata: { listId: list.id } })
    .catch(() => undefined);
  return list;
}

export async function updateList(businessId: string, listId: string, patch: UpdateListInput): Promise<ListRecord | null> {
  return new ListRepository(queryAsTenant(businessId)).update(listId, businessId, patch);
}

export async function deleteList(businessId: string, listId: string): Promise<boolean> {
  const deleted = await new ListRepository(queryAsTenant(businessId)).softDelete(listId, businessId);
  if (deleted) {
    await new SecurityAuditLogRepository(queryAsTenant(businessId))
      .record({ businessId, eventType: 'list_deleted', rawMetadata: { listId } })
      .catch(() => undefined);
  }
  return deleted;
}

export async function listMembers(businessId: string, listId: string): Promise<ListMemberRecord[]> {
  return new ListMemberRepository(queryAsTenant(businessId)).listMembersForList(businessId, listId);
}

export async function addMember(businessId: string, listId: string, memberType: ListMemberType, memberId: string): Promise<ListMemberRecord> {
  const member = await new ListMemberRepository(queryAsTenant(businessId)).addMember({ businessId, listId, memberType, memberId });
  await new SecurityAuditLogRepository(queryAsTenant(businessId))
    .record({ businessId, eventType: 'list_membership_changed', rawMetadata: { listId, memberType, action: 'added' } })
    .catch(() => undefined);
  return member;
}

export async function removeMember(businessId: string, listId: string, memberId: string): Promise<boolean> {
  const removed = await new ListMemberRepository(queryAsTenant(businessId)).removeMember(businessId, memberId);
  if (removed) {
    await new SecurityAuditLogRepository(queryAsTenant(businessId))
      .record({ businessId, eventType: 'list_membership_changed', rawMetadata: { listId, action: 'removed' } })
      .catch(() => undefined);
  }
  return removed;
}

export async function listAssignments(businessId: string, listId: string): Promise<ListAgentAssignmentRecord[]> {
  return new ListAgentAssignmentRepository(queryAsTenant(businessId)).listForList(businessId, listId);
}

export async function upsertAssignment(input: UpsertListAgentAssignmentInput): Promise<ListAgentAssignmentRecord> {
  const assignment = await new ListAgentAssignmentRepository(queryAsTenant(input.businessId)).upsert(input);
  await new SecurityAuditLogRepository(queryAsTenant(input.businessId))
    .record({
      businessId: input.businessId,
      eventType: assignment.enabled ? 'list_agent_assigned' : 'list_agent_unassigned',
      rawMetadata: { listId: input.listId, agentId: input.agentId },
    })
    .catch(() => undefined);
  return assignment;
}

export async function removeAssignment(businessId: string, listId: string, agentId: string): Promise<boolean> {
  const removed = await new ListAgentAssignmentRepository(queryAsTenant(businessId)).remove(businessId, listId, agentId);
  if (removed) {
    await new SecurityAuditLogRepository(queryAsTenant(businessId))
      .record({ businessId, eventType: 'list_agent_unassigned', rawMetadata: { listId, agentId } })
      .catch(() => undefined);
  }
  return removed;
}

/** Every List that applies to this chat, plus the single unambiguous candidate (if any) a caller may offer to auto-set as active. */
export async function getListsForChat(businessId: string, chatId: string): Promise<{ lists: ListRecord[]; unambiguousListId: string | null }> {
  const memberRepository = new ListMemberRepository(queryAsTenant(businessId));
  const lists = await memberRepository.resolveListsForChat(businessId, chatId);
  const unambiguousListId = await computeUnambiguousActiveList(businessId, chatId);
  return { lists, unambiguousListId };
}

export async function setActiveList(businessId: string, chatId: string, listId: string | null) {
  const auditLogRepository = new SecurityAuditLogRepository(queryAsTenant(businessId));

  // Relationship-Confidence Engine (Phase 3): a real signal for whether
  // the engine's own suggestion is actually useful - fires only when a
  // human's choice genuinely differs from what was suggested, never on
  // every setActiveList call (most calls have no signal row at all, e.g.
  // a business that never enabled the engine).
  const signal = await new ChatRelationshipSignalRepository(queryAsTenant(businessId)).findForChat(businessId, chatId).catch(() => null);
  if (signal?.suggestedListId && signal.suggestedListId !== listId) {
    await auditLogRepository
      .record({ businessId, eventType: 'relationship_suggestion_overridden', rawMetadata: { chatId, suggestedListId: signal.suggestedListId, chosenListId: listId } })
      .catch(() => undefined);
  }

  // A human explicitly confirming a List is the strongest possible
  // engagement signal - real history for the Relationship-Confidence
  // Engine's own recency tiebreak, whether or not it agreed with any
  // prior suggestion.
  if (listId) {
    await new ChatListEngagementRepository(queryAsTenant(businessId)).recordEngagement(businessId, chatId, listId).catch(() => undefined);
  }

  const chat = await new WhatsAppChatRepository(queryAsTenant(businessId)).setActiveList(chatId, businessId, listId);
  await auditLogRepository
    .record({ businessId, eventType: 'list_active_list_set', rawMetadata: { chatId, listId } })
    .catch(() => undefined);
  return chat;
}

/** Relationship-Confidence Engine (Phase 3): the business-level opt-in - off by default, matches customer_memory_enabled's own posture. */
export async function setRelationshipConfidenceEnabled(businessId: string, enabled: boolean) {
  const business = await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, enabled);
  await new SecurityAuditLogRepository(queryAsTenant(businessId))
    .record({ businessId, eventType: enabled ? 'relationship_confidence_enabled' : 'relationship_confidence_disabled', rawMetadata: {} })
    .catch(() => undefined);
  return business;
}

/** Every chat the developer/admin needs to look at right now - real, always-current candidates and the engine's own current suggestion, never a fabricated example row. */
export async function listAmbiguousRelationshipSignals(businessId: string, limit = 100): Promise<ChatRelationshipSignalRecord[]> {
  return new ChatRelationshipSignalRepository(queryAsTenant(businessId)).listAmbiguousForBusiness(businessId, limit);
}
