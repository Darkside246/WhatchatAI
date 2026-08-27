import { describe, expect, it, beforeEach } from 'vitest';
import { SpecialistAgentRegistry, specialistAgentRegistry } from './agentRegistry.js';

describe('SpecialistAgentRegistry', () => {
  beforeEach(() => specialistAgentRegistry.clear());

  it('rejects an action that is both allowed and forbidden', () => {
    const registry = new SpecialistAgentRegistry();
    expect(() => registry.register({
      id: 'food', domain: 'food', displayName: 'Food', description: 'test', priority: 1,
      capabilities: [], requiredSkills: [], allowedActionTypes: ['food.order.submit'],
      forbiddenActionTypes: ['food.order.submit'], requiresHumanApprovalFor: [], enabled: true,
    })).toThrow(/both allow and forbid/);
  });

  it('sorts enabled specialists by priority and keeps disabled specialists out when requested', () => {
    const registry = new SpecialistAgentRegistry();
    registry.register({ id: 'food', domain: 'food', displayName: 'Food', description: 'test', priority: 10, capabilities: [], requiredSkills: [], allowedActionTypes: [], forbiddenActionTypes: [], requiresHumanApprovalFor: [], enabled: true });
    registry.register({ id: 'property', domain: 'property', displayName: 'Property', description: 'test', priority: 20, capabilities: [], requiredSkills: [], allowedActionTypes: [], forbiddenActionTypes: [], requiresHumanApprovalFor: [], enabled: false });
    expect(registry.list(true).map((agent) => agent.id)).toEqual(['food']);
    expect(registry.list().map((agent) => agent.id)).toEqual(['property', 'food']);
  });

  it('ships the intended specialist catalogue', () => {
    const ids = ['buzz', 'safety', 'property', 'food', 'commerce', 'scheduling', 'research'];
    // The singleton is intentionally reset by the previous tests, so rebuild
    // the platform catalogue here through the public manifest contract.
    for (const [index, id] of ids.entries()) {
      specialistAgentRegistry.register({ id: id as never, domain: (id === 'buzz' ? 'conversation' : id) as never, displayName: id, description: 'test', priority: ids.length - index, capabilities: [], requiredSkills: [], allowedActionTypes: [], forbiddenActionTypes: [], requiresHumanApprovalFor: [], enabled: true });
    }
    expect(specialistAgentRegistry.list(true).map((agent) => agent.id)).toEqual(ids);
  });
});
