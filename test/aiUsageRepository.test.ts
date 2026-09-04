import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiUsageRepository } from '../src/repositories/aiUsageRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('AiUsageRepository (real Postgres - migration 954)', () => {
  let businessId: string;
  let agentId: string;
  const repo = new AiUsageRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent' });
    agentId = agent.id;
  });

  it('records a real usage event and it is included in the platform total', async () => {
    await repo.record({
      businessId,
      agentId,
      chatId: null,
      model: 'gemini-3.5-flash',
      callKind: 'primary',
      promptTokens: 100,
      candidatesTokens: 50,
      totalTokens: 150,
    });

    const total = await repo.getPlatformTotal(24);
    expect(total.totalTokens).toBe(150);
    expect(total.callCount).toBe(1);
  });

  it('excludes events older than the requested window', async () => {
    await repo.record({ businessId, agentId, chatId: null, model: 'gemini-3.5-flash', callKind: 'primary', promptTokens: 10, candidatesTokens: 10, totalTokens: 20 });
    await pool.query(`UPDATE ai_usage_events SET created_at = now() - interval '2 days'`);

    const last24h = await repo.getPlatformTotal(24);
    expect(last24h.totalTokens).toBe(0);
    expect(last24h.callCount).toBe(0);

    const last7d = await repo.getPlatformTotal(24 * 7);
    expect(last7d.totalTokens).toBe(20);
  });

  it('ranks real businesses by total usage, most-usage-first, with the real business name attached', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAgent = await new AiAgentRepository(pool).create({ businessId: otherBusinessId, name: 'Other Agent' });

    await repo.record({ businessId, agentId, chatId: null, model: 'gemini-3.5-flash', callKind: 'primary', promptTokens: 10, candidatesTokens: 10, totalTokens: 20 });
    await repo.record({ businessId: otherBusinessId, agentId: otherAgent.id, chatId: null, model: 'gemini-3.5-flash', callKind: 'primary', promptTokens: 100, candidatesTokens: 100, totalTokens: 200 });

    const top = await repo.getTopBusinessesByUsage(24);
    expect(top).toHaveLength(2);
    expect(top[0]?.businessId).toBe(otherBusinessId);
    expect(top[0]?.totalTokens).toBe(200);
    expect(top[0]?.businessName).toBe('Other Business');
    expect(top[1]?.businessId).toBe(businessId);
  });

  it('a business with a deleted agent still keeps its usage history (agent_id set null, not the row deleted)', async () => {
    await repo.record({ businessId, agentId, chatId: null, model: 'gemini-3.5-flash', callKind: 'primary', promptTokens: 5, candidatesTokens: 5, totalTokens: 10 });
    await pool.query('DELETE FROM ai_agents WHERE id = $1', [agentId]);

    const total = await repo.getPlatformTotal(24);
    expect(total.totalTokens).toBe(10);
  });

  /**
   * Real bug found live (Section 68 follow-up, same class as
   * whatsappMessageRepository.ts's countByDirectionPerDay fix): the doc
   * comment on getMonthlyTotalForBusiness always claimed "UTC via
   * date_trunc", but date_trunc('month', now()) truncates in the DB
   * session's timezone unless told otherwise. On a session behind UTC
   * (confirmed live: America/Blanc-Sablon, UTC-4/-3), the local month
   * doesn't roll over until a few hours after the true UTC month start -
   * an event that landed in the first moments of the real UTC month would
   * be wrongly excluded from "this month's" entitlement total under the
   * old, unforced query. This test places a real usage event exactly one
   * second into the true UTC month and proves it is counted even when the
   * query runs under a session timezone that would, unfixed, still think
   * the previous month hadn't ended.
   */
  it('getMonthlyTotalForBusiness counts an event from the first second of the true UTC month, even under a session timezone behind UTC', async () => {
    await repo.record({ businessId, agentId, chatId: null, model: 'gemini-3.5-flash', callKind: 'primary', promptTokens: 7, candidatesTokens: 3, totalTokens: 10 });
    await pool.query(
      `UPDATE ai_usage_events SET created_at = date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 second' WHERE business_id = $1`,
      [businessId],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL TIME ZONE 'America/Blanc-Sablon'`);
      const tzScopedRepo = new AiUsageRepository(client);
      const total = await tzScopedRepo.getMonthlyTotalForBusiness(businessId);
      await client.query('ROLLBACK');
      expect(total).toBe(10);
    } finally {
      client.release();
    }
  });
});
