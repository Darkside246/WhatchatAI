import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AgentWorkJournalRepository } from '../src/repositories/agentWorkJournalRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/** Backs the "While You Were Away" summary and the sweep's own audit trail (Section 41-42 Phase 1, migration 979). */
describe('AgentWorkJournalRepository (real Postgres - migration 979)', () => {
  const journal = new AgentWorkJournalRepository(pool);
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('records and lists a real entry', async () => {
    const entry = await journal.record({ businessId, agentId: null, entryType: 'FINDING', summary: 'A chat needs a human', detail: { chatId: 'chat-1' } });
    expect(entry.entryType).toBe('FINDING');

    const since = new Date(Date.now() - 60_000).toISOString();
    const listed = await journal.listSince(businessId, since);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.summary).toBe('A chat needs a human');
  });

  it('never leaks another business\'s journal entries (tenant isolation)', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await journal.record({ businessId: otherBusinessId, agentId: null, entryType: 'ACTION_TAKEN', summary: 'Other business action' });

    const since = new Date(Date.now() - 60_000).toISOString();
    const listed = await journal.listSince(businessId, since);
    expect(listed).toHaveLength(0);
  });

  it('excludes entries from before the requested window', async () => {
    await journal.record({ businessId, agentId: null, entryType: 'FINDING', summary: 'Old finding' });
    await pool.query(`UPDATE agent_work_journal SET occurred_at = now() - interval '2 days'`);

    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await journal.listSince(businessId, since)).toHaveLength(0);
  });

  it('countByTypeSince returns real, honest zero counts for every type with no fabricated defaults', async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await journal.countByTypeSince(businessId, since)).toEqual({ FINDING: 0, ACTION_TAKEN: 0, QUEUED_FOR_APPROVAL: 0, SKIPPED: 0 });
  });

  it('countByTypeSince counts each real entry type correctly', async () => {
    await journal.record({ businessId, agentId: null, entryType: 'FINDING', summary: 'f1' });
    await journal.record({ businessId, agentId: null, entryType: 'FINDING', summary: 'f2' });
    await journal.record({ businessId, agentId: null, entryType: 'ACTION_TAKEN', summary: 'a1' });

    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await journal.countByTypeSince(businessId, since)).toEqual({ FINDING: 2, ACTION_TAKEN: 1, QUEUED_FOR_APPROVAL: 0, SKIPPED: 0 });
  });

  it('a deleted agent\'s prior journal entries survive with agent_id set null (ON DELETE SET NULL), not deleted', async () => {
    const agentRepo = new AiAgentRepository(pool);
    const agent = await agentRepo.create({ businessId, name: 'Sweep Agent' });
    await journal.record({ businessId, agentId: agent.id, entryType: 'ACTION_TAKEN', summary: 'took an action' });
    await pool.query('DELETE FROM ai_agents WHERE id = $1', [agent.id]);

    const since = new Date(Date.now() - 60_000).toISOString();
    const listed = await journal.listSince(businessId, since);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.agentId).toBeNull();
  });
});
