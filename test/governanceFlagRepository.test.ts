import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { GovernanceFlagRepository } from '../src/repositories/governanceFlagRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestBusiness, createTestUser } from './helpers.js';

const now = new Date().toISOString();
const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();

describe('GovernanceFlagRepository (real Postgres, AI Governance & Oversight v1)', () => {
  it('creates a business-scoped flag and finds it via listForBusiness', async () => {
    const repo = new GovernanceFlagRepository(pool);
    const businessId = await createTestBusiness();
    const flag = await repo.create({
      businessId, agentId: null, flagType: 'high_sentinel_block_rate', severity: 'warning',
      metricValue: 20, thresholdValue: 15, windowStart: anHourAgo, windowEnd: now,
    });
    expect(flag.status).toBe('open');

    const forBusiness = await repo.listForBusiness(businessId);
    expect(forBusiness.map((f) => f.id)).toEqual([flag.id]);
  });

  it('listForBusiness never leaks another business\'s flag', async () => {
    const repo = new GovernanceFlagRepository(pool);
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    await repo.create({ businessId: businessA, agentId: null, flagType: 'high_sentinel_block_rate', severity: 'warning', metricValue: 20, thresholdValue: 15, windowStart: anHourAgo, windowEnd: now });
    expect(await repo.listForBusiness(businessB)).toEqual([]);
  });

  it('listOpenAcrossPlatform returns real business/agent names via its server-side join, and only open flags', async () => {
    const repo = new GovernanceFlagRepository(pool);
    const businessId = await createTestBusiness('Acme Corp');
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Support Agent' });
    const reviewerId = await createTestUser(businessId);
    const open = await repo.create({ businessId, agentId: agent.id, flagType: 'high_tool_denial_rate', severity: 'warning', metricValue: 25, thresholdValue: 20, windowStart: anHourAgo, windowEnd: now });
    const dismissed = await repo.create({ businessId, agentId: agent.id, flagType: 'high_tool_denial_rate', severity: 'warning', metricValue: 30, thresholdValue: 20, windowStart: anHourAgo, windowEnd: now });
    await repo.markDismissed(dismissed.id, reviewerId);

    const openFlags = await repo.listOpenAcrossPlatform();
    const found = openFlags.find((f) => f.id === open.id);
    expect(found?.businessName).toBe('Acme Corp');
    expect(found?.agentName).toBe('Support Agent');
    expect(openFlags.find((f) => f.id === dismissed.id)).toBeUndefined();
  });

  it('markReviewed and markDismissed are final - a resolved flag can never be resolved again, and each returns null on the second attempt', async () => {
    const repo = new GovernanceFlagRepository(pool);
    const businessId = await createTestBusiness();
    const reviewerId = await createTestUser(businessId);
    const flag = await repo.create({ businessId, agentId: null, flagType: 'high_output_leak_rate', severity: 'critical', metricValue: 10, thresholdValue: 5, windowStart: anHourAgo, windowEnd: now });

    const reviewed = await repo.markReviewed(flag.id, reviewerId);
    expect(reviewed?.status).toBe('reviewed');
    expect(reviewed?.reviewedByUserId).toBe(reviewerId);

    // Second call, whichever action, must fail - the row is no longer 'open'.
    expect(await repo.markReviewed(flag.id, reviewerId)).toBeNull();
    expect(await repo.markDismissed(flag.id, reviewerId)).toBeNull();

    // And it never reopens - listForBusiness's caller relies on status staying final.
    const stillResolved = await repo.listForBusiness(businessId);
    expect(stillResolved.find((f) => f.id === flag.id)?.status).toBe('reviewed');
  });

  it('findOpenByBusinessAgentAndType only matches an OPEN flag of the exact type, business, and agent', async () => {
    const repo = new GovernanceFlagRepository(pool);
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    const flag = await repo.create({ businessId, agentId: agent.id, flagType: 'high_tool_denial_rate', severity: 'warning', metricValue: 25, thresholdValue: 20, windowStart: anHourAgo, windowEnd: now });

    expect((await repo.findOpenByBusinessAgentAndType(businessId, agent.id, 'high_tool_denial_rate'))?.id).toBe(flag.id);
    // A different flag type for the same business/agent does not match.
    expect(await repo.findOpenByBusinessAgentAndType(businessId, agent.id, 'high_sentinel_block_rate')).toBeNull();
    // Business-scoped flags (agentId null) use IS NOT DISTINCT FROM, not a bare equality - confirm null/null matches.
    const businessScoped = await repo.create({ businessId, agentId: null, flagType: 'high_sentinel_block_rate', severity: 'warning', metricValue: 20, thresholdValue: 15, windowStart: anHourAgo, windowEnd: now });
    expect((await repo.findOpenByBusinessAgentAndType(businessId, null, 'high_sentinel_block_rate'))?.id).toBe(businessScoped.id);

    const reviewerId = await createTestUser(businessId);
    await repo.markReviewed(flag.id, reviewerId);
    // Once resolved, no longer found as "open".
    expect(await repo.findOpenByBusinessAgentAndType(businessId, agent.id, 'high_tool_denial_rate')).toBeNull();
  });

  it('follow-up: high_agent_output_leak_rate requires a real agentId, mirroring high_tool_denial_rate\'s own CHECK shape', async () => {
    const repo = new GovernanceFlagRepository(pool);
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });

    const flag = await repo.create({ businessId, agentId: agent.id, flagType: 'high_agent_output_leak_rate', severity: 'critical', metricValue: 3, thresholdValue: 3, windowStart: anHourAgo, windowEnd: now });
    expect(flag.agentId).toBe(agent.id);

    await expect(
      repo.create({ businessId, agentId: null, flagType: 'high_agent_output_leak_rate', severity: 'critical', metricValue: 3, thresholdValue: 3, windowStart: anHourAgo, windowEnd: now }),
    ).rejects.toThrow();
  });

  it('follow-up: the existing business-scoped high_output_leak_rate rule is untouched - still requires agentId to be null', async () => {
    const repo = new GovernanceFlagRepository(pool);
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });

    await expect(
      repo.create({ businessId, agentId: agent.id, flagType: 'high_output_leak_rate', severity: 'critical', metricValue: 5, thresholdValue: 5, windowStart: anHourAgo, windowEnd: now }),
    ).rejects.toThrow();
  });
});
