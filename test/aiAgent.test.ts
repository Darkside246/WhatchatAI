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

  it('defaults to autonomyLevel: 3, and round-trips a real change through create and update', async () => {
    const defaultAgent = await agents.create({ businessId, name: 'Default Agent' });
    expect(defaultAgent.autonomyLevel).toBe(3);

    const created = await agents.create({ businessId, name: 'Cautious Agent', autonomyLevel: 2 });
    expect(created.autonomyLevel).toBe(2);

    const updated = await agents.update(created.id, { name: 'Cautious Agent', autonomyLevel: 3 });
    expect(updated?.autonomyLevel).toBe(3);
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

  describe('proactive_mode (Section 41-42 Phase 1)', () => {
    it('defaults every new agent to OFF - nothing opts into the autonomous sweep silently', async () => {
      const agent = await agents.create({ businessId, name: 'New Agent' });
      expect(agent.proactiveMode).toBe('OFF');
    });

    it('updateProactiveMode round-trips a real change', async () => {
      const agent = await agents.create({ businessId, name: 'Agent' });
      await agents.updateProactiveMode(agent.id, 'AUTONOMOUS');
      const updated = await agents.findById(agent.id);
      expect(updated?.proactiveMode).toBe('AUTONOMOUS');
    });

    it('getMostPermissiveProactiveMode is OFF when every agent is OFF', async () => {
      await agents.create({ businessId, name: 'Agent 1' });
      await agents.create({ businessId, name: 'Agent 2' });
      expect(await agents.getMostPermissiveProactiveMode(businessId)).toBe('OFF');
    });

    it('getMostPermissiveProactiveMode picks the most permissive real mode across agents', async () => {
      const assisted = await agents.create({ businessId, name: 'Assisted Agent' });
      await agents.updateProactiveMode(assisted.id, 'ASSISTED');
      const autonomous = await agents.create({ businessId, name: 'Autonomous Agent' });
      await agents.updateProactiveMode(autonomous.id, 'AUTONOMOUS');

      expect(await agents.getMostPermissiveProactiveMode(businessId)).toBe('DELEGATED');
    });

    it('getMostPermissiveProactiveMode ignores a paused or deleted agent\'s mode', async () => {
      const paused = await agents.create({ businessId, name: 'Paused Agent' });
      await agents.updateProactiveMode(paused.id, 'AUTONOMOUS');
      await agents.updateStatus(paused.id, 'PAUSED');

      expect(await agents.getMostPermissiveProactiveMode(businessId)).toBe('OFF');
    });

    it('listBusinessIdsWithProactiveModeEnabled only includes a business with at least one real non-OFF agent', async () => {
      const otherBusinessId = await createTestBusiness('Other Business');
      const agent = await agents.create({ businessId, name: 'Agent' });
      await agents.updateProactiveMode(agent.id, 'DELEGATED');
      await agents.create({ businessId: otherBusinessId, name: 'Off Agent' });

      const enabled = await agents.listBusinessIdsWithProactiveModeEnabled();
      expect(enabled).toContain(businessId);
      expect(enabled).not.toContain(otherBusinessId);
    });
  });
});
