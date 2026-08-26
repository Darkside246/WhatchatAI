import { z } from 'zod';

const SkillManifestSchema = z.object({
  id: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), name: z.string().min(1).max(200), description: z.string().min(1).max(2000),
  capabilities: z.array(z.string().min(1)).max(100), requiredTools: z.array(z.string().min(1)).max(100), allowedActions: z.array(z.string().min(1)).max(100), forbiddenActions: z.array(z.string().min(1)).max(100),
  requiresHumanApprovalFor: z.array(z.string().min(1)).max(100), maxRiskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), supportedChannels: z.array(z.enum(['WHATSAPP', 'VOICE', 'SMS', 'EMAIL', 'WEB'])).max(10), enabled: z.boolean(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export class SkillRegistry {
  private readonly skills = new Map<string, SkillManifest>();
  register(skill: SkillManifest): SkillManifest { const parsed = SkillManifestSchema.parse(skill); if (parsed.forbiddenActions.some((action) => parsed.allowedActions.includes(action))) throw new Error(`skill ${parsed.id} cannot both allow and forbid action`); if (this.skills.has(parsed.id)) throw new Error(`skill ${parsed.id} is already registered`); this.skills.set(parsed.id, parsed); return parsed; }
  get(id: string): SkillManifest | null { return this.skills.get(id) ?? null; }
  list(enabledOnly = false): SkillManifest[] { return [...this.skills.values()].filter((skill) => !enabledOnly || skill.enabled); }
  enable(id: string): void { const skill = this.require(id); this.skills.set(id, { ...skill, enabled: true }); }
  disable(id: string): void { const skill = this.require(id); this.skills.set(id, { ...skill, enabled: false }); }
  canExecuteAction(id: string, actionType: string): boolean { const skill = this.get(id); return Boolean(skill?.enabled && skill.allowedActions.includes(actionType) && !skill.forbiddenActions.includes(actionType)); }
  requiresApproval(id: string, actionType: string): boolean { return this.require(id).requiresHumanApprovalFor.includes(actionType); }
  clear(): void { this.skills.clear(); }
  private require(id: string): SkillManifest { const skill = this.get(id); if (!skill) throw new Error(`skill ${id} is not registered`); return skill; }
}

export const skillRegistry = new SkillRegistry();
export const propertyMaintenanceTriageSkill: SkillManifest = {
  id: 'property.maintenance.triage', version: '1.0.0', name: 'Property Maintenance Triage',
  description: 'Classifies inbound property maintenance communications and prepares bounded operational actions.',
  capabilities: ['communication.interpret', 'media.analyse', 'property.context.read', 'asset.context.read', 'maintenance.classify'],
  requiredTools: ['property.read', 'asset.read', 'maintenance.create_work_order'],
  allowedActions: ['maintenance.create_work_order', 'maintenance.request_human_review'],
  forbiddenActions: ['property.issue_refund', 'lease.modify', 'payment.authorize', 'vendor.dispatch_unapproved'],
  requiresHumanApprovalFor: ['maintenance.create_work_order'],
  maxRiskLevel: 'CRITICAL',
  supportedChannels: ['WHATSAPP', 'VOICE', 'SMS'],
  enabled: false,
};
