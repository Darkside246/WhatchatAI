import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { ChatListEngagementRepository } from '../src/repositories/chatListEngagementRepository.js';
import { ListRepository } from '../src/repositories/listRepository.js';
import { createTestAccount, createTestBusiness } from './helpers.js';

async function createChat(businessId: string, accountId: string, jid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_chats (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type) VALUES ($1, $2, $3, 'individual', 'individual') RETURNING id`,
    [businessId, accountId, jid],
  );
  return rows[0]!.id;
}

describe('ChatListEngagementRepository (real Postgres, Relationship-Confidence Engine follow-up)', () => {
  it('recordEngagement creates a real row on first call, count=1', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '1@s.whatsapp.net');
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const repo = new ChatListEngagementRepository(queryAsTenant(businessId));

    const record = await repo.recordEngagement(businessId, chatId, list.id);
    expect(record.engagementCount).toBe(1);
  });

  it('recordEngagement increments IN PLACE - repeated calls never create a second row and refresh last_active_at', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '2@s.whatsapp.net');
    const list = await new ListRepository(queryAsTenant(businessId)).create({ businessId, name: 'Work' });
    const repo = new ChatListEngagementRepository(queryAsTenant(businessId));

    const first = await repo.recordEngagement(businessId, chatId, list.id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.recordEngagement(businessId, chatId, list.id);

    expect(second.id).toBe(first.id);
    expect(second.engagementCount).toBe(2);
    expect(new Date(second.lastActiveAt).getTime()).toBeGreaterThanOrEqual(new Date(first.lastActiveAt).getTime());

    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM chat_list_engagement WHERE chat_id = $1', [chatId]);
    expect(rows[0]?.count).toBe('1');
  });

  it('getEngagementForCandidates returns only real rows - a candidate never engaged is simply absent, never a fabricated zero', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '3@s.whatsapp.net');
    const listRepo = new ListRepository(queryAsTenant(businessId));
    const engagedList = await listRepo.create({ businessId, name: 'Work' });
    const neverEngagedList = await listRepo.create({ businessId, name: 'Friends' });
    const repo = new ChatListEngagementRepository(queryAsTenant(businessId));
    await repo.recordEngagement(businessId, chatId, engagedList.id);

    const results = await repo.getEngagementForCandidates(businessId, chatId, [engagedList.id, neverEngagedList.id]);
    expect(results).toHaveLength(1);
    expect(results[0]?.listId).toBe(engagedList.id);
  });

  it('getEngagementForCandidates returns [] for an empty candidate list without querying', async () => {
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const chatId = await createChat(businessId, accountId, '4@s.whatsapp.net');
    const repo = new ChatListEngagementRepository(queryAsTenant(businessId));
    expect(await repo.getEngagementForCandidates(businessId, chatId, [])).toEqual([]);
  });

  it('never leaks another business\'s engagement history', async () => {
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const accountA = await createTestAccount(businessA, '15550001111@s.whatsapp.net');
    const chatA = await createChat(businessA, accountA, '5@s.whatsapp.net');
    const listA = await new ListRepository(queryAsTenant(businessA)).create({ businessId: businessA, name: 'Work' });
    await new ChatListEngagementRepository(queryAsTenant(businessA)).recordEngagement(businessA, chatA, listA.id);

    expect(await new ChatListEngagementRepository(queryAsTenant(businessB)).getEngagementForCandidates(businessB, chatA, [listA.id])).toEqual([]);
  });
});
