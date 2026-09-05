import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { ListRepository } from '../src/repositories/listRepository.js';
import { ListMemberRepository } from '../src/repositories/listMemberRepository.js';
import { ListAgentAssignmentRepository, AutonomyOverrideExceedsAgentError } from '../src/repositories/listAgentAssignmentRepository.js';
import { ListScopedMemoryRepository, ListScopedMemoryConflictError } from '../src/repositories/listScopedMemoryRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

async function createTestAgent(businessId: string, name = 'Test Agent', autonomyLevel = 3): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ai_agents (business_id, name, status, autonomy_level) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id`,
    [businessId, name, autonomyLevel],
  );
  return rows[0]!.id;
}

async function createTestContact(businessId: string, accountId: string, jid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_contacts (business_id, whatsapp_account_id, whatsapp_jid, jid_kind) VALUES ($1, $2, $3, 'individual') RETURNING id`,
    [businessId, accountId, jid],
  );
  return rows[0]!.id;
}

async function createTestChat(businessId: string, accountId: string, jid: string, contactId: string | null = null, groupId: string | null = null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_chats (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type, contact_id, group_id)
     VALUES ($1, $2, $3, 'individual', 'individual', $4, $5) RETURNING id`,
    [businessId, accountId, jid, contactId, groupId],
  );
  return rows[0]!.id;
}

async function createTestGroup(businessId: string, accountId: string, jid = 'group-1@g.us'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_groups (business_id, whatsapp_account_id, group_jid, name, subject) VALUES ($1, $2, $3, 'Test Group', 'Test Group') RETURNING id`,
    [businessId, accountId, jid],
  );
  return rows[0]!.id;
}

async function createTestCustomer(businessId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [businessId]);
  return rows[0]!.id;
}

describe('AURA Lists (Phase 1, real Postgres) - ListRepository', () => {
  it('creates, lists, updates, and soft-deletes a List, all business-scoped', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new ListRepository(queryAsTenant(businessId));

    const list = await repo.create({ businessId, name: 'Work', description: 'Professional contacts' });
    expect(list.name).toBe('Work');

    const found = await repo.findByIdForBusiness(list.id, businessId);
    expect(found?.id).toBe(list.id);

    const listed = await repo.listByBusiness(businessId);
    expect(listed.map((l) => l.name)).toEqual(['Work']);

    const updated = await repo.update(list.id, businessId, { description: 'Updated description' });
    expect(updated?.description).toBe('Updated description');

    expect(await repo.softDelete(list.id, businessId)).toBe(true);
    expect(await repo.findByIdForBusiness(list.id, businessId)).toBeNull();
    expect(await repo.listByBusiness(businessId)).toEqual([]);
  });

  it('never leaks another business\'s Lists', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    await new ListRepository(queryAsTenant(businessA)).create({ businessId: businessA, name: 'Family' });

    const listsForB = await new ListRepository(queryAsTenant(businessB)).listByBusiness(businessB);
    expect(listsForB).toEqual([]);
  });
});

describe('AURA Lists (Phase 1, real Postgres) - ListMemberRepository.resolveListsForChat', () => {
  it('resolves a List via direct chat membership', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '1@s.whatsapp.net');

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    const list = await listRepo.create({ businessId, name: 'Work' });
    await memberRepo.addMember({ businessId, listId: list.id, memberType: 'chat', memberId: chatId });

    const resolved = await memberRepo.resolveListsForChat(businessId, chatId);
    expect(resolved.map((l) => l.id)).toEqual([list.id]);
  });

  it('resolves a List via contact membership (whatsapp_chats.contact_id)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const contactId = await createTestContact(businessId, accountId, '2@s.whatsapp.net');
    const chatId = await createTestChat(businessId, accountId, '2@s.whatsapp.net', contactId);

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    const list = await listRepo.create({ businessId, name: 'Friends' });
    await memberRepo.addMember({ businessId, listId: list.id, memberType: 'contact', memberId: contactId });

    const resolved = await memberRepo.resolveListsForChat(businessId, chatId);
    expect(resolved.map((l) => l.id)).toEqual([list.id]);
  });

  it('resolves a List via group membership (whatsapp_chats.group_id)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const groupId = await createTestGroup(businessId, accountId);
    const chatId = await createTestChat(businessId, accountId, 'group-1@g.us', null, groupId);

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    const list = await listRepo.create({ businessId, name: 'Community' });
    await memberRepo.addMember({ businessId, listId: list.id, memberType: 'group', memberId: groupId });

    const resolved = await memberRepo.resolveListsForChat(businessId, chatId);
    expect(resolved.map((l) => l.id)).toEqual([list.id]);
  });

  it('the cross-list case: a contact belonging to two Lists resolves both, and neither is silently preferred', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const contactId = await createTestContact(businessId, accountId, '3@s.whatsapp.net');
    const chatId = await createTestChat(businessId, accountId, '3@s.whatsapp.net', contactId);

    const listRepo = new ListRepository(queryAsTenant(businessId));
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    const work = await listRepo.create({ businessId, name: 'Work' });
    const friends = await listRepo.create({ businessId, name: 'Friends' });
    await memberRepo.addMember({ businessId, listId: work.id, memberType: 'contact', memberId: contactId });
    await memberRepo.addMember({ businessId, listId: friends.id, memberType: 'contact', memberId: contactId });

    const resolved = await memberRepo.resolveListsForChat(businessId, chatId);
    expect(resolved.map((l) => l.name).sort()).toEqual(['Friends', 'Work']);
  });

  it('returns [] for a chat with no membership anywhere, never guessing', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '4@s.whatsapp.net');
    const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
    expect(await memberRepo.resolveListsForChat(businessId, chatId)).toEqual([]);
  });

  it('never leaks another business\'s List membership', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const accountA = await createTestAccount(businessA, '15550001111@s.whatsapp.net');
    const chatA = await createTestChat(businessA, accountA, '5@s.whatsapp.net');
    const listA = await new ListRepository(queryAsTenant(businessA)).create({ businessId: businessA, name: 'A-list' });
    await new ListMemberRepository(queryAsTenant(businessA)).addMember({ businessId: businessA, listId: listA.id, memberType: 'chat', memberId: chatA });

    const resolvedForB = await new ListMemberRepository(queryAsTenant(businessB)).resolveListsForChat(businessB, chatA);
    expect(resolvedForB).toEqual([]);
  });
});

describe('AURA Lists (Phase 1, real Postgres) - ListAgentAssignmentRepository', () => {
  it('upserts an assignment, findEnabledForList only returns enabled rows', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agentId = await createTestAgent(businessId);
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const repo = new ListAgentAssignmentRepository(queryAsTenant(businessId));

    await repo.upsert({ businessId, listId: list.id, agentId, enabled: false });
    expect(await repo.findEnabledForList(businessId, list.id)).toBeNull();

    await repo.upsert({ businessId, listId: list.id, agentId, enabled: true });
    const found = await repo.findEnabledForList(businessId, list.id);
    expect(found?.agentId).toBe(agentId);
    expect(found?.useConversationHistory).toBe(true); // default
  });

  it('restrict-only: rejects an autonomyOverride greater than the agent\'s own autonomyLevel', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agentId = await createTestAgent(businessId, 'Agent', 2); // autonomyLevel 2
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const repo = new ListAgentAssignmentRepository(queryAsTenant(businessId));

    await expect(repo.upsert({ businessId, listId: list.id, agentId, autonomyOverride: 4 })).rejects.toThrow(AutonomyOverrideExceedsAgentError);
    // A more restrictive override than the agent's own level is fine.
    const assignment = await repo.upsert({ businessId, listId: list.id, agentId, autonomyOverride: 1 });
    expect(assignment.autonomyOverride).toBe(1);
  });

  it('autonomyOverride is only touched when explicitly provided - an unrelated patch never wipes a previously-set override', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agentId = await createTestAgent(businessId, 'Agent', 3);
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const repo = new ListAgentAssignmentRepository(queryAsTenant(businessId));

    await repo.upsert({ businessId, listId: list.id, agentId, autonomyOverride: 2 });
    const afterUnrelatedPatch = await repo.upsert({ businessId, listId: list.id, agentId, requireApproval: true });
    expect(afterUnrelatedPatch.autonomyOverride).toBe(2);
    expect(afterUnrelatedPatch.requireApproval).toBe(true);
  });

  it('never leaks another business\'s assignment', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const agentA = await createTestAgent(businessA);
    const listA = await new ListRepository(queryAsTenant(businessA)).create({ businessId: businessA, name: 'Work' });
    await new ListAgentAssignmentRepository(queryAsTenant(businessA)).upsert({ businessId: businessA, listId: listA.id, agentId: agentA, enabled: true });

    expect(await new ListAgentAssignmentRepository(queryAsTenant(businessB)).findEnabledForList(businessB, listA.id)).toBeNull();
  });
});

describe('AURA Lists (Phase 1, real Postgres) - ListScopedMemoryRepository (THE hard-must isolation proof)', () => {
  it('the same real customer under two different Lists produces two disjoint, mutually-invisible rows', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const customerId = await createTestCustomer(businessId);
    const workList = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const friendsList = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Friends' });
    const repo = new ListScopedMemoryRepository(queryAsTenant(businessId));

    const workMemory = await repo.getOrCreate(businessId, workList.id, customerId);
    await repo.update(businessId, workList.id, customerId, workMemory.version, {
      confirmedFacts: [{ key: 'salary', value: '120k', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }],
    });

    // The identical customerId, queried under the OTHER List, must see none of it.
    const friendsMemory = await repo.find(businessId, friendsList.id, customerId);
    expect(friendsMemory).toBeNull();

    const friendsMemoryCreated = await repo.getOrCreate(businessId, friendsList.id, customerId);
    expect(friendsMemoryCreated.confirmedFacts).toEqual([]);

    // And the Work-list row is untouched by the Friends-list read/create above.
    const workMemoryAgain = await repo.find(businessId, workList.id, customerId);
    expect(workMemoryAgain?.confirmedFacts).toEqual([{ key: 'salary', value: '120k', origin: 'user_confirmed', confirmedAt: expect.any(String) }]);
  });

  it('update() rejects a stale version with a real CAS conflict', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const customerId = await createTestCustomer(businessId);
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const repo = new ListScopedMemoryRepository(queryAsTenant(businessId));
    await repo.getOrCreate(businessId, list.id, customerId);

    await expect(
      repo.update(businessId, list.id, customerId, 999, { confirmedFacts: [{ key: 'k', value: 'v', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }] }),
    ).rejects.toThrow(ListScopedMemoryConflictError);
  });

  it('deleteByListAndCustomer only erases the named List\'s row, leaving other Lists\' memory for the same customer intact', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const customerId = await createTestCustomer(businessId);
    const workList = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const friendsList = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Friends' });
    const repo = new ListScopedMemoryRepository(queryAsTenant(businessId));
    await repo.getOrCreate(businessId, workList.id, customerId);
    await repo.getOrCreate(businessId, friendsList.id, customerId);

    expect(await repo.deleteByListAndCustomer(businessId, workList.id, customerId)).toBe(true);
    expect(await repo.find(businessId, workList.id, customerId)).toBeNull();
    expect(await repo.find(businessId, friendsList.id, customerId)).not.toBeNull();
  });

  it('never leaks another business\'s list-scoped memory', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const customerA = await createTestCustomer(businessA);
    const listA = await new ListRepository(queryAsTenant(businessA)).create({ businessId: businessA, name: 'Work' });
    await new ListScopedMemoryRepository(queryAsTenant(businessA)).getOrCreate(businessA, listA.id, customerA);

    expect(await new ListScopedMemoryRepository(queryAsTenant(businessB)).find(businessB, listA.id, customerA)).toBeNull();
  });
});

describe('AURA Lists (Phase 1, real Postgres) - whatsapp_chats.active_list_id / setActiveList', () => {
  it('defaults to null for any chat, and can be set/cleared via setActiveList', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '6@s.whatsapp.net');
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const chatRepo = new WhatsAppChatRepository(pool);

    const before = await chatRepo.findById(chatId);
    expect(before?.activeListId).toBeNull();

    const after = await chatRepo.setActiveList(chatId, businessId, list.id);
    expect(after?.activeListId).toBe(list.id);

    const cleared = await chatRepo.setActiveList(chatId, businessId, null);
    expect(cleared?.activeListId).toBeNull();
  });

  it('setActiveList is business-scoped - a wrong businessId updates nothing', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const otherBusinessId = await createTestBusiness('Other');
    const accountId = await createTestAccount(businessId);
    const chatId = await createTestChat(businessId, accountId, '7@s.whatsapp.net');
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const chatRepo = new WhatsAppChatRepository(pool);

    expect(await chatRepo.setActiveList(chatId, otherBusinessId, list.id)).toBeNull();
    expect((await chatRepo.findById(chatId))?.activeListId).toBeNull();
  });
});
