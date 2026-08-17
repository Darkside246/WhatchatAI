import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../src/services/authService.js';
import { workspaceService, isChatNotFoundError } from '../src/services/workspaceService.js';
import { ADVICE_RESTRICTED_CATEGORIES } from '../src/repositories/aiAgentRepository.js';
import { createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('AI agent configuration (real persisted config, real tenant isolation)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
  });

  it('persists every configurable field through a real update, not just the name', async () => {
    const created = await workspaceService.createAgent(businessId, { name: 'Front desk' });
    expect(created.category).toBe('general');
    expect(created.triggerKeywords).toEqual([]);
    expect(created.responseDelaySeconds).toBe(0);

    const updated = await workspaceService.updateAgent(businessId, created.id, {
      name: 'Emergency dispatch',
      category: 'plumbing',
      specialization: 'emergency callouts only',
      persona: 'Calm dispatcher',
      tone: 'reassuring',
      triggerKeywords: ['leak', 'burst', 'flood'],
      blockedKeywords: ['refund', 'legal'],
      responseDelaySeconds: 12,
      priority: 50,
    });

    expect(updated.name).toBe('Emergency dispatch');
    expect(updated.category).toBe('plumbing');
    expect(updated.specialization).toBe('emergency callouts only');
    expect(updated.triggerKeywords).toEqual(['leak', 'burst', 'flood']);
    expect(updated.blockedKeywords).toEqual(['refund', 'legal']);
    expect(updated.responseDelaySeconds).toBe(12);
    expect(updated.priority).toBe(50);

    // Re-read from the database rather than trusting the returned row.
    const reloaded = (await workspaceService.listAgents(businessId)).find((agent) => agent.id === created.id);
    expect(reloaded?.category).toBe('plumbing');
    expect(reloaded?.triggerKeywords).toEqual(['leak', 'burst', 'flood']);
  });

  it('refuses to update an agent belonging to a different business', async () => {
    const created = await workspaceService.createAgent(businessId, { name: 'Ours' });
    const otherBusinessId = await createTestBusiness('Other Business');

    await expect(workspaceService.updateAgent(otherBusinessId, created.id, { name: 'Hijacked' })).rejects.toThrow();
    try {
      await workspaceService.updateAgent(otherBusinessId, created.id, { name: 'Hijacked' });
    } catch (error) {
      expect(isChatNotFoundError(error)).toBe(true);
    }

    const untouched = (await workspaceService.listAgents(businessId)).find((agent) => agent.id === created.id);
    expect(untouched?.name).toBe('Ours');
  });

  it('refuses to make an agent its own parent, or to point hierarchy at another business\'s agent', async () => {
    const agent = await workspaceService.createAgent(businessId, { name: 'Self' });
    await expect(
      workspaceService.updateAgent(businessId, agent.id, { name: 'Self', parentAgentId: agent.id }),
    ).rejects.toThrow();

    const otherBusinessId = await createTestBusiness('Other Business');
    await createTestSubscription(otherBusinessId);
    const foreign = await workspaceService.createAgent(otherBusinessId, { name: 'Foreign' });
    await expect(
      workspaceService.updateAgent(businessId, agent.id, { name: 'Self', escalateToAgentId: foreign.id }),
    ).rejects.toThrow();
  });

  it('links a real hierarchy between two agents of the same business', async () => {
    const manager = await workspaceService.createAgent(businessId, { name: 'Manager', category: 'general' });
    const junior = await workspaceService.createAgent(businessId, { name: 'Junior', category: 'bookings' });

    const linked = await workspaceService.updateAgent(businessId, junior.id, {
      name: 'Junior',
      category: 'bookings',
      parentAgentId: manager.id,
      escalateToAgentId: manager.id,
    });

    expect(linked.parentAgentId).toBe(manager.id);
    expect(linked.escalateToAgentId).toBe(manager.id);
  });

  it('classifies the hazardous/regulated trades as advice-restricted, so their prompt carries the operations-only limit', () => {
    for (const category of ['plumbing', 'electrical', 'mechanical', 'hvac', 'construction'] as const) {
      expect(ADVICE_RESTRICTED_CATEGORIES).toContain(category);
    }
    // Non-hazardous categories must NOT be restricted - a sales agent should
    // still be able to answer questions about what it sells.
    for (const category of ['sales', 'support', 'bookings', 'beauty'] as const) {
      expect(ADVICE_RESTRICTED_CATEGORIES).not.toContain(category);
    }
  });
});
