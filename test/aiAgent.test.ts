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

  it('defaults to allowedToolsEnabled: false and empty tool lists - every pre-existing agent keeps offering every connection-eligible tool, unchanged', async () => {
    const agent = await agents.create({ businessId, name: 'Default Agent' });
    expect(agent.allowedToolsEnabled).toBe(false);
    expect(agent.allowedTools).toEqual([]);
    expect(agent.forbiddenTools).toEqual([]);
  });

  it('round-trips a real capability restriction through create and update', async () => {
    const created = await agents.create({
      businessId,
      name: 'Restricted Agent',
      allowedToolsEnabled: true,
      allowedTools: ['get_current_time', 'schedule_google_meet'],
      forbiddenTools: ['schedule_zoom_meeting'],
    });
    expect(created.allowedToolsEnabled).toBe(true);
    expect(created.allowedTools).toEqual(['get_current_time', 'schedule_google_meet']);
    expect(created.forbiddenTools).toEqual(['schedule_zoom_meeting']);

    const updated = await agents.update(created.id, {
      name: 'Restricted Agent',
      allowedToolsEnabled: false,
      allowedTools: [],
      forbiddenTools: ['schedule_zoom_meeting'],
    });
    expect(updated?.allowedToolsEnabled).toBe(false);
    expect(updated?.forbiddenTools).toEqual(['schedule_zoom_meeting']);
  });

  it('defaults to requiresApprovalForActions: false, and round-trips a real change through create and update', async () => {
    const defaultAgent = await agents.create({ businessId, name: 'Default Agent' });
    expect(defaultAgent.requiresApprovalForActions).toBe(false);

    const created = await agents.create({ businessId, name: 'Cautious Agent', requiresApprovalForActions: true });
    expect(created.requiresApprovalForActions).toBe(true);

    const updated = await agents.update(created.id, { name: 'Cautious Agent', requiresApprovalForActions: false });
    expect(updated?.requiresApprovalForActions).toBe(false);
  });

  it('defaults to null source template provenance, and round-trips a real value through create and update', async () => {
    const defaultAgent = await agents.create({ businessId, name: 'Default Agent' });
    expect(defaultAgent.sourceTemplateKey).toBeNull();
    expect(defaultAgent.sourceTemplateVersion).toBeNull();

    const created = await agents.create({ businessId, name: 'From Template', sourceTemplateKey: 'personal_assistant', sourceTemplateVersion: 1 });
    expect(created.sourceTemplateKey).toBe('personal_assistant');
    expect(created.sourceTemplateVersion).toBe(1);

    const updated = await agents.update(created.id, { name: 'From Template', sourceTemplateKey: 'personal_assistant', sourceTemplateVersion: 2 });
    expect(updated?.sourceTemplateVersion).toBe(2);
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

  describe('findActiveForBusiness (single-agent-per-business v1 scope)', () => {
    it('returns null when the business has no active agent configured - never fabricates one', async () => {
      const active = await agents.findActiveForBusiness(businessId);
      expect(active).toBeNull();
    });

    it('ignores PAUSED and ARCHIVED agents entirely', async () => {
      const paused = await agents.create({ businessId, name: 'Paused Agent' });
      await agents.updateStatus(paused.id, 'PAUSED');
      const archived = await agents.create({ businessId, name: 'Archived Agent' });
      await agents.updateStatus(archived.id, 'ARCHIVED');

      const active = await agents.findActiveForBusiness(businessId);
      expect(active).toBeNull();
    });

    it('returns the most recently created ACTIVE agent when more than one exists', async () => {
      await agents.create({ businessId, name: 'Older Agent' });
      const newer = await agents.create({ businessId, name: 'Newer Agent' });

      const active = await agents.findActiveForBusiness(businessId);
      expect(active?.id).toBe(newer.id);
    });
  });
});
