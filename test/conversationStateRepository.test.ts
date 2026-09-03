import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  ConversationStateRepository,
  ConversationStateConflictError,
  type ConversationFact,
} from '../src/repositories/conversationStateRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';

async function createTestChat(businessId: string, accountId: string, jid = '15550009999@s.whatsapp.net'): Promise<string> {
  const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
    businessId,
    whatsappAccountId: accountId,
    chatJid: jid,
    jidKind: 'individual',
    chatType: 'individual',
  });
  return chat.id;
}

describe('ConversationStateRepository', () => {
  let businessId: string;
  let chatId: string;
  let repo: ConversationStateRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    chatId = await createTestChat(businessId, accountId);
    repo = new ConversationStateRepository(pool);
  });

  it('getOrCreate creates a fresh, empty state row on first access', async () => {
    const state = await repo.getOrCreate(businessId, chatId);
    expect(state.currentGoal).toBeNull();
    expect(state.confirmedFacts).toEqual([]);
    expect(state.openQuestions).toEqual([]);
    expect(state.pendingActions).toEqual([]);
    expect(state.funnelStage).toBeNull();
    expect(state.customerReadiness).toBeNull();
    expect(state.version).toBe(1);
  });

  it('update() persists funnelStage and customerReadiness as a current-state snapshot', async () => {
    const state = await repo.getOrCreate(businessId, chatId);
    const updated = await repo.update(businessId, chatId, state.version, { funnelStage: 'QUALIFIED', customerReadiness: 'INTERESTED' });
    expect(updated.funnelStage).toBe('QUALIFIED');
    expect(updated.customerReadiness).toBe('INTERESTED');
  });

  it('the real database CHECK constraint rejects a funnel_stage value outside the known set, defense-in-depth below the application layer', async () => {
    await repo.getOrCreate(businessId, chatId);
    await expect(
      pool.query(`UPDATE conversation_states SET funnel_stage = 'NOT_A_REAL_STAGE' WHERE business_id = $1 AND chat_id = $2`, [businessId, chatId]),
    ).rejects.toThrow();
  });

  it('getOrCreate returns the same row on repeated calls, never duplicating', async () => {
    const first = await repo.getOrCreate(businessId, chatId);
    const second = await repo.getOrCreate(businessId, chatId);
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM conversation_states WHERE business_id = $1 AND chat_id = $2',
      [businessId, chatId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('update() applies a patch and increments the version', async () => {
    const state = await repo.getOrCreate(businessId, chatId);
    const fact: ConversationFact = { key: 'unit_number', value: '4B', origin: 'user_confirmed', confirmedAt: new Date().toISOString() };

    const updated = await repo.update(businessId, chatId, state.version, {
      currentGoal: { description: 'Resolve the AC complaint', setAt: new Date().toISOString() },
      confirmedFacts: [fact],
    });

    expect(updated.version).toBe(state.version + 1);
    expect(updated.currentGoal?.description).toBe('Resolve the AC complaint');
    expect(updated.confirmedFacts).toEqual([fact]);
    expect(updated.openQuestions).toEqual([]); // untouched field stays as-is
  });

  it('update() throws ConversationStateConflictError when expectedVersion is stale', async () => {
    const state = await repo.getOrCreate(businessId, chatId);
    await repo.update(businessId, chatId, state.version, { currentGoal: { description: 'first writer', setAt: new Date().toISOString() } });

    await expect(
      repo.update(businessId, chatId, state.version, { currentGoal: { description: 'stale writer', setAt: new Date().toISOString() } }),
    ).rejects.toThrow(ConversationStateConflictError);
  });

  it('never silently loses an update under real concurrent writers - the loser gets a conflict, not a merged/overwritten result', async () => {
    const state = await repo.getOrCreate(businessId, chatId);

    const results = await Promise.allSettled([
      repo.update(businessId, chatId, state.version, { openQuestions: [{ id: 'q1', question: 'What unit?', openedAt: new Date().toISOString(), resolvedAt: null }] }),
      repo.update(businessId, chatId, state.version, { openQuestions: [{ id: 'q2', question: 'When did it start?', openedAt: new Date().toISOString(), resolvedAt: null }] }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConversationStateConflictError);

    const final = await repo.find(businessId, chatId);
    expect(final!.version).toBe(state.version + 1);
  });

  it('re-read-and-retry recovers from a conflict and lands the second writer\'s intent', async () => {
    const state = await repo.getOrCreate(businessId, chatId);
    await repo.update(businessId, chatId, state.version, { currentGoal: { description: 'first', setAt: new Date().toISOString() } });

    let current = await repo.find(businessId, chatId);
    let updated = null;
    for (let attempt = 0; attempt < 3 && !updated; attempt++) {
      try {
        updated = await repo.update(businessId, chatId, current!.version, { openQuestions: [{ id: 'q1', question: 'retry target', openedAt: new Date().toISOString(), resolvedAt: null }] });
      } catch (error) {
        if (!(error instanceof ConversationStateConflictError)) throw error;
        current = await repo.find(businessId, chatId);
      }
    }
    expect(updated).not.toBeNull();
    expect(updated!.openQuestions[0]!.id).toBe('q1');
    expect(updated!.currentGoal?.description).toBe('first'); // untouched by the retried patch
  });

  it('tenant isolation - a conversation state is scoped to its business, not resolvable from another', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await repo.getOrCreate(businessId, chatId);
    const foundInOther = await repo.find(otherBusinessId, chatId);
    expect(foundInOther).toBeNull();
  });
});
