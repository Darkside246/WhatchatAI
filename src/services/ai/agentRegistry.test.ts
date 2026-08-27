import { describe, expect, it } from 'vitest';
import { SpecialistAgentRegistry } from './agentRegistry.js';

describe('SpecialistAgentRegistry', () => {
  it('rejects an action that is both allowed and forbidden', () => {
    const registry = new SpecialistAgentRegistry();
    expect(() => registry.register({
      id: 'food', domain: 'food', displayName: 'Food', description: 'test', priority: 1,
      capabilities: [], requiredSkills: [], allowedActionTypes: ['food.order.submit'],
      forbiddenActionTypes: ['food.order.submit'], requiresHumanApprovalFor: [], enabled: true,
    })).toThrow(/both allow and forbid/);
  });

  it('sorts enabled specialists and excludes disabled agents when requested', () => {
    const registry = new SpecialistAgentRegistry();
    registry.register({ id: 'food', domain: 'food', displayName: 'Food', description: 'test', priority: 10, capabilities: [], requiredSkills: [], allowedActionTypes: [], forbiddenActionTypes: [], requiresHumanApprovalFor: [], enabled: true });
    registry.register({ id: 'property', domain: 'property', displayName: 'Property', description: 'test', priority: 20, capabilities: [], requiredSkills: [], allowedActionTypes: [], forbiddenActionTypes: [], requiresHumanApprovalFor: [], enabled: false });
    expect(registry.list(true).map((agent) => agent.id)).toEqual(['food']);
    expect(registry.list().map((agent) => agent.id)).toEqual(['property', 'food']);
  });

  it('keeps property and food specialists independently scoped', () => {
    const registry = new SpecialistAgentRegistry();
    registry.register({ id: 'property', domain: 'property', displayName: 'Property', description: 'maintenance', priority: 80, capabilities: ['maintenance.triage'], requiredSkills: ['property.maintenance.triage'], allowedActionTypes: ['maintenance.create_work_order'], forbiddenActionTypes: ['payment.authorize'], requiresHumanApprovalFor: ['maintenance.create_work_order'], enabled: true });
    registry.register({ id: 'food', domain: 'food', displayName: 'Food', description: 'orders', priority: 75, capabilities: ['order.build'], requiredSkills: [], allowedActionTypes: ['food.order.submit'], forbiddenActionTypes: ['payment.authorize'], requiresHumanApprovalFor: ['food.order.submit'], enabled: true });
    expect(registry.get('property')?.domain).toBe('property');
    expect(registry.get('food')?.capabilities).toContain('order.build');
  });
});
