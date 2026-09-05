import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { ListRepository } from '../src/repositories/listRepository.js';
import { ListAgentAssignmentRepository } from '../src/repositories/listAgentAssignmentRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { resolveAgentRouting, computeUnambiguousActiveList } from '../src/services/listRoutingService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

async function createChat(businessId: string, accountId: string, jid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_chats (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type) VALUES ($1, $2, $3, 'individual', 'individual') RETURNING id`,
    [businessId, accountId, jid],
  );
  return rows[0]!.id;
}

describe('listRoutingService.resolveAgentRouting (real Postgres) - Lists take precedence, blocked-keywords never bypassed, safe fallback', () => {
  it('routes via the chat\'s active List assignment, even when a different agent\'s trigger keyword would otherwise have matched', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '1@s.whatsapp.net');

    const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
    const keywordAgent = await agentRepo.create({ businessId, name: 'Keyword Agent', triggerKeywords: ['invoice'] });
    const listAgent = await agentRepo.create({ businessId, name: 'List Agent' });

    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    await new ListAgentAssignmentRepository(queryAsTenant(businessId)).upsert({ businessId, listId: list.id, agentId: listAgent.id, enabled: true });
    await new WhatsAppChatRepository(pool).setActiveList(chatId, businessId, list.id);

    const decision = await resolveAgentRouting(businessId, chatId, 'Can you send the invoice over?');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') expect(decision.agent.id).toBe(listAgent.id);
    void keywordAgent;
  });

  it('blocked-keyword escalation still wins even with an active List assignment - List assignment never bypasses safety', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '2@s.whatsapp.net');

    const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
    const guardAgent = await agentRepo.create({ businessId, name: 'Guard Agent', blockedKeywords: ['refund'] });
    const listAgent = await agentRepo.create({ businessId, name: 'List Agent' });

    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    await new ListAgentAssignmentRepository(queryAsTenant(businessId)).upsert({ businessId, listId: list.id, agentId: listAgent.id, enabled: true });
    await new WhatsAppChatRepository(pool).setActiveList(chatId, businessId, list.id);

    const decision = await resolveAgentRouting(businessId, chatId, 'I want a refund please');
    expect(decision.outcome).toBe('escalate_to_human');
    void guardAgent;
  });

  it('falls back to the existing keyword+priority router when the chat has no active List', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '3@s.whatsapp.net');
    await new AiAgentRepository(queryAsTenant(businessId)).create({ businessId, name: 'Generalist' });

    const decision = await resolveAgentRouting(businessId, chatId, 'hello there');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') expect(decision.agent.name).toBe('Generalist');
  });

  it('falls back to keyword+priority routing when the active List\'s assignment is disabled', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '4@s.whatsapp.net');

    const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
    const listAgent = await agentRepo.create({ businessId, name: 'List Agent' });
    const generalist = await agentRepo.create({ businessId, name: 'Generalist' });

    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    await new ListAgentAssignmentRepository(queryAsTenant(businessId)).upsert({ businessId, listId: list.id, agentId: listAgent.id, enabled: false });
    await new WhatsAppChatRepository(pool).setActiveList(chatId, businessId, list.id);

    const decision = await resolveAgentRouting(businessId, chatId, 'hello there');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') expect(decision.agent.id).toBe(generalist.id);
  });

  it('falls back to keyword+priority routing when the assigned agent is no longer ACTIVE', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '5@s.whatsapp.net');

    const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
    const listAgent = await agentRepo.create({ businessId, name: 'List Agent' });
    await agentRepo.updateStatus(listAgent.id, 'PAUSED');
    const generalist = await agentRepo.create({ businessId, name: 'Generalist' });

    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    await new ListAgentAssignmentRepository(queryAsTenant(businessId)).upsert({ businessId, listId: list.id, agentId: listAgent.id, enabled: true });
    await new WhatsAppChatRepository(pool).setActiveList(chatId, businessId, list.id);

    const decision = await resolveAgentRouting(businessId, chatId, 'hello there');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') expect(decision.agent.id).toBe(generalist.id);
  });
});

describe('listRoutingService.computeUnambiguousActiveList (real Postgres) - never guess between competing Lists', () => {
  it('returns the single candidate when exactly one matched List has an enabled assignment', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '6@s.whatsapp.net');
    const agent = await new AiAgentRepository(queryAsTenant(businessId)).create({ businessId, name: 'Agent' });

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const list = await listRepo.create({ businessId, name: 'Work' });
    const { ListMemberRepository } = await import('../src/repositories/listMemberRepository.js');
    await new ListMemberRepository(queryAsTenant(businessId)).addMember({ businessId, listId: list.id, memberType: 'chat', memberId: chatId });
    await new ListAgentAssignmentRepository(queryAsTenant(businessId)).upsert({ businessId, listId: list.id, agentId: agent.id, enabled: true });

    expect(await computeUnambiguousActiveList(businessId, chatId)).toBe(list.id);
  });

  it('returns null (never guesses) when two matched Lists both have an enabled assignment', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '7@s.whatsapp.net');
    const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
    const agentA = await agentRepo.create({ businessId, name: 'Agent A' });
    const agentB = await agentRepo.create({ businessId, name: 'Agent B' });

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const listA = await listRepo.create({ businessId, name: 'Work' });
    const listB = await listRepo.create({ businessId, name: 'Friends' });
    const { ListMemberRepository } = await import('../src/repositories/listMemberRepository.js');
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    await memberRepo.addMember({ businessId, listId: listA.id, memberType: 'chat', memberId: chatId });
    await memberRepo.addMember({ businessId, listId: listB.id, memberType: 'chat', memberId: chatId });
    const assignmentRepo = new ListAgentAssignmentRepository(queryAsTenant(businessId));
    await assignmentRepo.upsert({ businessId, listId: listA.id, agentId: agentA.id, enabled: true });
    await assignmentRepo.upsert({ businessId, listId: listB.id, agentId: agentB.id, enabled: true });

    expect(await computeUnambiguousActiveList(businessId, chatId)).toBeNull();
  });

  it('returns null when no matched List has any enabled assignment', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '8@s.whatsapp.net');
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const { ListMemberRepository } = await import('../src/repositories/listMemberRepository.js');
    await new ListMemberRepository(queryAsTenant(businessId)).addMember({ businessId, listId: list.id, memberType: 'chat', memberId: chatId });

    expect(await computeUnambiguousActiveList(businessId, chatId)).toBeNull();
  });
});

describe('listRoutingService.resolveAgentRouting - Relationship-Confidence Engine (Phase 3) integration, real Postgres', () => {
  it('an opted-in business with a clear keyword winner routes to the Relationship-Confidence Engine\'s suggestion', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const { BusinessRepository } = await import('../src/repositories/businessRepository.js');
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);

    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '9@s.whatsapp.net');
    const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
    const workAgent = await agentRepo.create({ businessId, name: 'Work Agent', triggerKeywords: ['invoice'] });
    const friendsAgent = await agentRepo.create({ businessId, name: 'Friends Agent', triggerKeywords: ['weekend'] });

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const workList = await listRepo.create({ businessId, name: 'Work' });
    const friendsList = await listRepo.create({ businessId, name: 'Friends' });
    const { ListMemberRepository } = await import('../src/repositories/listMemberRepository.js');
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    await memberRepo.addMember({ businessId, listId: workList.id, memberType: 'chat', memberId: chatId });
    await memberRepo.addMember({ businessId, listId: friendsList.id, memberType: 'chat', memberId: chatId });
    const assignmentRepo = new ListAgentAssignmentRepository(queryAsTenant(businessId));
    await assignmentRepo.upsert({ businessId, listId: workList.id, agentId: workAgent.id, enabled: true });
    await assignmentRepo.upsert({ businessId, listId: friendsList.id, agentId: friendsAgent.id, enabled: true });

    const decision = await resolveAgentRouting(businessId, chatId, 'Can you send the invoice over?');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') expect(decision.agent.id).toBe(workAgent.id);
  });

  it('an opted-OUT business (the default) behaves identically to before this phase existed - falls back to keyword+priority routing, never the Relationship-Confidence Engine', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    // Deliberately never enabling relationship_confidence_enabled.

    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '10@s.whatsapp.net');
    const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
    const workAgent = await agentRepo.create({ businessId, name: 'Work Agent', triggerKeywords: ['invoice'] });
    const generalist = await agentRepo.create({ businessId, name: 'Generalist' });

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const workList = await listRepo.create({ businessId, name: 'Work' });
    const friendsList = await listRepo.create({ businessId, name: 'Friends' });
    const { ListMemberRepository } = await import('../src/repositories/listMemberRepository.js');
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    await memberRepo.addMember({ businessId, listId: workList.id, memberType: 'chat', memberId: chatId });
    await memberRepo.addMember({ businessId, listId: friendsList.id, memberType: 'chat', memberId: chatId });
    const assignmentRepo = new ListAgentAssignmentRepository(queryAsTenant(businessId));
    await assignmentRepo.upsert({ businessId, listId: workList.id, agentId: workAgent.id, enabled: true });
    // friendsList deliberately left with no assignment - only workList's own keyword would ever match anyway.

    // The message matches Work's own trigger keyword, but since the engine
    // is off, this must resolve via the plain keyword+priority router
    // (which also happens to match "invoice" against workAgent directly) -
    // the real proof is the OTHER test below, where the engine is off and
    // no keyword matches at all, landing on the generalist instead.
    const decision = await resolveAgentRouting(businessId, chatId, 'hello, just checking in');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') expect(decision.agent.id).toBe(generalist.id);
  });
});

describe('listRoutingService.resolveAgentRouting - engagement-history recording follow-up, real Postgres', () => {
  it('a message routed via the chat\'s active List assignment records real engagement for that List', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '11@s.whatsapp.net');
    const agent = await new AiAgentRepository(queryAsTenant(businessId)).create({ businessId, name: 'Agent' });
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    await new ListAgentAssignmentRepository(queryAsTenant(businessId)).upsert({ businessId, listId: list.id, agentId: agent.id, enabled: true });
    await new WhatsAppChatRepository(pool).setActiveList(chatId, businessId, list.id);

    // Engagement recording is awaited inside resolveAgentRouting (not
    // fire-and-forget - a cheap upsert, and awaiting it removes a real
    // race with resetDatabase()'s own TRUNCATE in a later test), so it's
    // guaranteed to have landed the moment this call returns.
    await resolveAgentRouting(businessId, chatId, 'hello there');

    const { ChatListEngagementRepository } = await import('../src/repositories/chatListEngagementRepository.js');
    const engagement = await new ChatListEngagementRepository(queryAsTenant(businessId)).getEngagementForCandidates(businessId, chatId, [list.id]);
    expect(engagement).toHaveLength(1);
    expect(engagement[0]?.engagementCount).toBe(1);
  });

  it('a message that falls through to the plain keyword+priority router (no active List, engine off) records no engagement at all', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '12@s.whatsapp.net');
    await new AiAgentRepository(queryAsTenant(businessId)).create({ businessId, name: 'Generalist' });
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });

    await resolveAgentRouting(businessId, chatId, 'hello there');

    const { ChatListEngagementRepository } = await import('../src/repositories/chatListEngagementRepository.js');
    const engagement = await new ChatListEngagementRepository(queryAsTenant(businessId)).getEngagementForCandidates(businessId, chatId, [list.id]);
    expect(engagement).toEqual([]);
  });
});
