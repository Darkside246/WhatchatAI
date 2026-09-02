import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiUsageRepository } from '../src/repositories/aiUsageRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { getAiUsageOverview } from '../src/services/productAccountService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('getAiUsageOverview (real Postgres, composes AiUsageRepository)', () => {
  it('runs cleanly against an empty database - no usage recorded yet', async () => {
    await resetDatabase();
    const overview = await getAiUsageOverview();
    expect(overview.last24h).toEqual({ totalTokens: 0, callCount: 0 });
    expect(overview.last7d).toEqual({ totalTokens: 0, callCount: 0 });
    expect(overview.topBusinessesLast24h).toEqual([]);
  });

  it('reports real recorded usage in both the 24h total and the top-businesses list', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent' });
    await new AiUsageRepository(pool).record({
      businessId,
      agentId: agent.id,
      chatId: null,
      model: 'gemini-3.5-flash',
      callKind: 'primary',
      promptTokens: 40,
      candidatesTokens: 60,
      totalTokens: 100,
    });

    const overview = await getAiUsageOverview();
    expect(overview.last24h.totalTokens).toBe(100);
    expect(overview.last7d.totalTokens).toBe(100);
    expect(overview.topBusinessesLast24h).toHaveLength(1);
    expect(overview.topBusinessesLast24h[0]?.totalTokens).toBe(100);
  });
});
