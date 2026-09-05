import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { ChatRelationshipSignalRepository, type RelationshipCandidate } from '../src/repositories/chatRelationshipSignalRepository.js';
import { ListRepository } from '../src/repositories/listRepository.js';
import { createTestAccount, createTestBusiness } from './helpers.js';

async function createChat(businessId: string, accountId: string, jid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_chats (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type) VALUES ($1, $2, $3, 'individual', 'individual') RETURNING id`,
    [businessId, accountId, jid],
  );
  return rows[0]!.id;
}

function makeCandidates(workListId: string): RelationshipCandidate[] {
  return [
    { listId: workListId, listName: 'Work', agentId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', agentName: 'Work Agent', matchedKeywords: ['invoice'], score: 1 },
    { listId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', listName: 'Friends', agentId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', agentName: 'Personal Agent', matchedKeywords: [], score: 0 },
  ];
}

describe('ChatRelationshipSignalRepository (real Postgres, Relationship-Confidence Engine Phase 3)', () => {
  it('upsert creates a real row, findForChat returns it with the right candidates/suggestion', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '1@s.whatsapp.net');
    const workList = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const candidates = makeCandidates(workList.id);
    const repo = new ChatRelationshipSignalRepository(queryAsTenant(businessId));

    const created = await repo.upsert({ businessId, chatId, candidates, suggestedListId: workList.id });
    expect(created.suggestedListId).toBe(workList.id);
    expect(created.candidates).toHaveLength(2);

    const found = await repo.findForChat(businessId, chatId);
    expect(found?.id).toBe(created.id);
    expect(found?.candidates[0]?.listName).toBe('Work');
  });

  it('upsert refreshes IN PLACE - a second call for the same chat updates the same row, never creates a second one', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '2@s.whatsapp.net');
    const workList = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const candidates = makeCandidates(workList.id);
    const repo = new ChatRelationshipSignalRepository(queryAsTenant(businessId));

    const first = await repo.upsert({ businessId, chatId, candidates, suggestedListId: workList.id });
    const second = await repo.upsert({ businessId, chatId, candidates: [candidates[0]!], suggestedListId: null });

    expect(second.id).toBe(first.id); // same row, not a new one
    expect(second.suggestedListId).toBeNull();
    expect(second.candidates).toHaveLength(1);

    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM chat_relationship_signals WHERE chat_id = $1', [chatId]);
    expect(rows[0]?.count).toBe('1');
  });

  it('listAmbiguousForBusiness only returns rows with 2+ real candidates', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const ambiguousChat = await createChat(businessId, accountId, '3@s.whatsapp.net');
    const resolvedChat = await createChat(businessId, accountId, '4@s.whatsapp.net');
    const candidates = makeCandidates('cccccccc-cccc-cccc-cccc-cccccccccccc'); // suggestedListId stays null below - JSONB candidates carry no FK, only the column does
    const repo = new ChatRelationshipSignalRepository(queryAsTenant(businessId));

    await repo.upsert({ businessId, chatId: ambiguousChat, candidates, suggestedListId: null });
    await repo.upsert({ businessId, chatId: resolvedChat, candidates: [candidates[0]!], suggestedListId: null });

    const ambiguous = await repo.listAmbiguousForBusiness(businessId);
    expect(ambiguous.map((s) => s.chatId)).toEqual([ambiguousChat]);
  });

  it('never leaks another business\'s relationship signal', async () => {
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const accountA = await createTestAccount(businessA, '15550001111@s.whatsapp.net');
    const chatA = await createChat(businessA, accountA, '5@s.whatsapp.net');
    const candidates = makeCandidates('cccccccc-cccc-cccc-cccc-cccccccccccc');
    await new ChatRelationshipSignalRepository(queryAsTenant(businessA)).upsert({ businessId: businessA, chatId: chatA, candidates, suggestedListId: null });

    expect(await new ChatRelationshipSignalRepository(queryAsTenant(businessB)).findForChat(businessB, chatA)).toBeNull();
    expect(await new ChatRelationshipSignalRepository(queryAsTenant(businessB)).listAmbiguousForBusiness(businessB)).toEqual([]);
  });
});
