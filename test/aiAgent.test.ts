import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('AiAgentRepository', () => {
  let businessId: string;
  let agents: AiAgentRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    agents = new AiAgentRepository(pool);
  });

  it('persists a real agent configuration', async () => {
    const agent = await agents.create({
      businessId,
      name: 'Sales Agent',
      persona: 'Friendly and concise',
      systemInstruction: 'Help qualify inbound leads.',
    });

    expect(agent.name).toBe('Sales Agent');
    expect(agent.status).toBe('ACTIVE');
  });

  it('only counts ACTIVE/PAUSED agents toward the plan limit, not ARCHIVED ones', async () => {
    const a = await agents.create({ businessId, name: 'Reception Agent' });
    const b = await agents.create({ businessId, name: 'Support Agent' });
    await agents.create({ businessId, name: 'Old Agent' });

    await agents.updateStatus(a.id, 'PAUSED');
    const archived = await agents.create({ businessId, name: 'To Archive' });
    await agents.updateStatus(archived.id, 'ARCHIVED');

    const count = await agents.countActiveByBusiness(businessId);
    // Reception (now PAUSED), Support (ACTIVE), Old Agent (ACTIVE) = 3 active/paused; the archived one is excluded.
    expect(count).toBe(3);
    void b;
  });
});
