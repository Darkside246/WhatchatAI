import { describe, expect, it } from 'vitest';
import { propertyMaintenanceTriageSkill, SkillRegistry } from './skillRegistry.js';

describe('SkillRegistry', () => {
  it('registers and discovers enabled skills', () => {
    const registry = new SkillRegistry();
    registry.register({ ...propertyMaintenanceTriageSkill, enabled: true });
    expect(registry.list(true).map((skill) => skill.id)).toEqual(['property.maintenance.triage']);
  });

  it('rejects overlapping allow and deny action lists', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register({
      ...propertyMaintenanceTriageSkill,
      allowedActions: ['maintenance.create_work_order'],
      forbiddenActions: ['maintenance.create_work_order'],
    })).toThrow('both allow and forbid');
  });

  it('requires enabled skills for action authorization', () => {
    const registry = new SkillRegistry();
    registry.register(propertyMaintenanceTriageSkill);
    expect(registry.canExecuteAction(propertyMaintenanceTriageSkill.id, 'maintenance.create_work_order')).toBe(false);
    registry.enable(propertyMaintenanceTriageSkill.id);
    expect(registry.canExecuteAction(propertyMaintenanceTriageSkill.id, 'maintenance.create_work_order')).toBe(true);
  });

  it('always denies forbidden actions', () => {
    const registry = new SkillRegistry();
    registry.register({ ...propertyMaintenanceTriageSkill, enabled: true });
    expect(registry.canExecuteAction(propertyMaintenanceTriageSkill.id, 'lease.modify')).toBe(false);
  });

  it('preserves approval requirements as policy metadata', () => {
    const registry = new SkillRegistry();
    registry.register({ ...propertyMaintenanceTriageSkill, enabled: true });
    expect(registry.requiresApproval(propertyMaintenanceTriageSkill.id, 'maintenance.create_work_order')).toBe(true);
  });
});
