import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ConversationStateRepository, ConversationStateConflictError } from '../src/repositories/conversationStateRepository.js';
import { applyConversationStateUpdate, recordNameUsed } from '../src/services/state/conversationStateWriter.js';
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

describe('applyConversationStateUpdate', () => {
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

  it('creates the state row on first write and sets the goal', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, { goal: 'Resolve the AC complaint' });
    const state = await repo.find(businessId, chatId);
    expect(state?.currentGoal?.description).toBe('Resolve the AC complaint');
  });

  it('a bare tool call with no real content is a no-op and never creates a row', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, {});
    const state = await repo.find(businessId, chatId);
    expect(state).toBeNull();
  });

  it('an empty-string goal clears an existing goal rather than being ignored', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, { goal: 'first goal' });
    await applyConversationStateUpdate(repo, businessId, chatId, { goal: '   ' });
    const state = await repo.find(businessId, chatId);
    expect(state?.currentGoal).toBeNull();
  });

  it('confirmed facts are unconditionally stamped user_confirmed regardless of tool call arguments', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, {
      confirmFacts: [{ key: 'unit_number', value: '4B' }],
    });
    const state = await repo.find(businessId, chatId);
    expect(state?.confirmedFacts).toEqual([
      expect.objectContaining({ key: 'unit_number', value: '4B', origin: 'user_confirmed' }),
    ]);
  });

  it('a repeated fact with the same key overwrites the value rather than duplicating', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, { confirmFacts: [{ key: 'unit_number', value: '4B' }] });
    await applyConversationStateUpdate(repo, businessId, chatId, { confirmFacts: [{ key: 'unit_number', value: '5C' }] });
    const state = await repo.find(businessId, chatId);
    expect(state?.confirmedFacts).toHaveLength(1);
    expect(state?.confirmedFacts[0]?.value).toBe('5C');
  });

  it('a blank key or value in confirmFacts is skipped rather than written', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, {
      confirmFacts: [{ key: '   ', value: 'x' }, { key: 'y', value: '   ' }],
    });
    const state = await repo.find(businessId, chatId);
    expect(state).toBeNull();
  });

  it('opens a new question and never opens a duplicate of an already-open one', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, { openQuestions: [{ question: 'What unit number?' }] });
    await applyConversationStateUpdate(repo, businessId, chatId, { openQuestions: [{ question: 'What unit number?' }, { question: 'When did it start?' }] });
    const state = await repo.find(businessId, chatId);
    const openTexts = state?.openQuestions.filter((q) => !q.resolvedAt).map((q) => q.question);
    expect(openTexts).toEqual(['What unit number?', 'When did it start?']);
  });

  it('resolves an open question by matching text case-insensitively, leaving other open questions untouched', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, {
      openQuestions: [{ question: 'What unit number?' }, { question: 'When did it start?' }],
    });
    await applyConversationStateUpdate(repo, businessId, chatId, { resolveQuestions: ['what unit number?'] });

    const state = await repo.find(businessId, chatId);
    const resolved = state?.openQuestions.find((q) => q.question === 'What unit number?');
    const stillOpen = state?.openQuestions.find((q) => q.question === 'When did it start?');
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(stillOpen?.resolvedAt).toBeNull();
  });

  it('a single call can set the goal, confirm a fact, and open a question together in one write', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, {
      goal: 'Book a repair visit',
      confirmFacts: [{ key: 'address', value: '12 Main St' }],
      openQuestions: [{ question: 'Preferred time window?' }],
    });
    const state = await repo.find(businessId, chatId);
    expect(state?.currentGoal?.description).toBe('Book a repair visit');
    expect(state?.confirmedFacts).toHaveLength(1);
    expect(state?.openQuestions).toHaveLength(1);
    expect(state?.version).toBe(2); // one getOrCreate insert (version 1) + one update (version 2)
  });

  describe('Section 08 (question priority engine)', () => {
    it('stores the priority the model assigned when opening a question', async () => {
      await applyConversationStateUpdate(repo, businessId, chatId, { openQuestions: [{ question: 'What is the delivery address?', priority: 'HIGH' }] });
      const state = await repo.find(businessId, chatId);
      expect(state?.openQuestions[0]?.priority).toBe('HIGH');
    });

    it('defaults to MEDIUM when the model omits priority', async () => {
      await applyConversationStateUpdate(repo, businessId, chatId, { openQuestions: [{ question: 'No priority given' }] });
      const state = await repo.find(businessId, chatId);
      expect(state?.openQuestions[0]?.priority).toBe('MEDIUM');
    });

    it('never trusts an invalid priority value just because a tool call claims it - falls back to MEDIUM', async () => {
      await applyConversationStateUpdate(repo, businessId, chatId, { openQuestions: [{ question: 'Bad priority', priority: 'URGENT!!' as never }] });
      const state = await repo.find(businessId, chatId);
      expect(state?.openQuestions[0]?.priority).toBe('MEDIUM');
    });
  });

  it('retries through a genuine optimistic-concurrency conflict rather than losing the update', async () => {
    const state = await repo.getOrCreate(businessId, chatId);
    const realUpdate = repo.update.bind(repo);
    let calls = 0;
    vi.spyOn(repo, 'update').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        // Simulate a concurrent writer winning the race on the very first attempt.
        await realUpdate(businessId, chatId, state.version, { currentGoal: { description: 'concurrent writer', setAt: new Date().toISOString() } });
      }
      return realUpdate(...args);
    });

    await applyConversationStateUpdate(repo, businessId, chatId, { confirmFacts: [{ key: 'k', value: 'v' }] });

    expect(calls).toBeGreaterThanOrEqual(2);
    const final = await repo.find(businessId, chatId);
    expect(final?.currentGoal?.description).toBe('concurrent writer'); // the concurrent writer's goal survived
    expect(final?.confirmedFacts).toEqual([expect.objectContaining({ key: 'k', value: 'v' })]); // and this write still landed
  });

  it('sets funnelStage and customerReadiness, and overwrites rather than merging on a later write', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, { funnelStage: 'INTENT_IDENTIFIED', customerReadiness: 'BROWSING' });
    let state = await repo.find(businessId, chatId);
    expect(state?.funnelStage).toBe('INTENT_IDENTIFIED');
    expect(state?.customerReadiness).toBe('BROWSING');

    await applyConversationStateUpdate(repo, businessId, chatId, { funnelStage: 'QUALIFIED' });
    state = await repo.find(businessId, chatId);
    expect(state?.funnelStage).toBe('QUALIFIED');
    expect(state?.customerReadiness).toBe('BROWSING'); // untouched by the funnelStage-only write
  });

  it('ignores a funnelStage or customerReadiness value outside the known set rather than throwing or writing it', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, {
      // @ts-expect-error - deliberately an invalid value, simulating a tool call that bypassed the schema's own enum constraint
      funnelStage: 'NOT_A_REAL_STAGE',
      goal: 'still writes the rest of the patch',
    });
    const state = await repo.find(businessId, chatId);
    expect(state?.funnelStage).toBeNull();
    expect(state?.currentGoal?.description).toBe('still writes the rest of the patch');
  });

  it('Section 15: sets preferredName, and an empty string clears it - same convention as goal', async () => {
    await applyConversationStateUpdate(repo, businessId, chatId, { preferredName: 'Mike' });
    let state = await repo.find(businessId, chatId);
    expect(state?.preferredName).toBe('Mike');

    await applyConversationStateUpdate(repo, businessId, chatId, { preferredName: '   ' });
    state = await repo.find(businessId, chatId);
    expect(state?.preferredName).toBeNull();
  });

  it('Section 19: recordNameUsed sets lastNameUsedAt to a real, current timestamp, creating the row if needed', async () => {
    const before = Date.now();
    await recordNameUsed(repo, businessId, chatId);
    const state = await repo.find(businessId, chatId);
    expect(state?.lastNameUsedAt).not.toBeNull();
    expect(new Date(state!.lastNameUsedAt!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('gives up and throws after exhausting retries against a permanently stale version', async () => {
    vi.spyOn(repo, 'update').mockRejectedValue(new ConversationStateConflictError(businessId, chatId, 999));
    await expect(applyConversationStateUpdate(repo, businessId, chatId, { goal: 'never lands' })).rejects.toThrow(
      ConversationStateConflictError,
    );
  });
});
