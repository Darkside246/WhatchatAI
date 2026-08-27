import { z } from 'zod';

export const SpecialistAgentIdSchema = z.enum([
  'buzz',
  'safety',
  'property',
  'food',
  'commerce',
  'scheduling',
  'research',
]);
export type SpecialistAgentId = z.infer<typeof SpecialistAgentIdSchema>;

export const AgentDomainSchema = z.enum(['conversation', 'safety', 'property', 'food', 'commerce', 'scheduling', 'research']);
export type AgentDomain = z.infer<typeof AgentDomainSchema>;

export const SpecialistAgentManifestSchema = z.object({
  id: SpecialistAgentIdSchema,
  domain: AgentDomainSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  priority: z.number().int().min(0).max(1000),
  capabilities: z.array(z.string().min(1).max(120)).max(50),
  requiredSkills: z.array(z.string().min(1).max(120)).max(50),
  allowedActionTypes: z.array(z.string().min(1).max(160)).max(100),
  forbiddenActionTypes: z.array(z.string().min(1).max(160)).max(100),
  requiresHumanApprovalFor: z.array(z.string().min(1).max(160)).max(100),
  enabled: z.boolean(),
});
export type SpecialistAgentManifest = z.infer<typeof SpecialistAgentManifestSchema>;

/**
 * In-process catalogue for the platform's specialist roles. This is a
 * capability contract, not a second source of tenant configuration. Tenant
 * activation, permissions and identity remain owned by the existing agent
 * repository and SkillRegistry.
 */
export class SpecialistAgentRegistry {
  private readonly agents = new Map<SpecialistAgentId, SpecialistAgentManifest>();

  register(manifest: SpecialistAgentManifest): SpecialistAgentManifest {
    const parsed = SpecialistAgentManifestSchema.parse(manifest);
    if (parsed.forbiddenActionTypes.some((action) => parsed.allowedActionTypes.includes(action))) {
      throw new Error(`agent ${parsed.id} cannot both allow and forbid action ${parsed.forbiddenActionTypes.find((action) => parsed.allowedActionTypes.includes(action))}`);
    }
    if (this.agents.has(parsed.id)) throw new Error(`specialist agent "${parsed.id}" is already registered`);
    this.agents.set(parsed.id, parsed);
    return parsed;
  }

  get(id: SpecialistAgentId): SpecialistAgentManifest | null {
    return this.agents.get(id) ?? null;
  }

  list(enabledOnly = false): SpecialistAgentManifest[] {
    return [...this.agents.values()]
      .filter((agent) => !enabledOnly || agent.enabled)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  clear(): void {
    this.agents.clear();
  }
}

export const specialistAgentRegistry = new SpecialistAgentRegistry();

const manifests: SpecialistAgentManifest[] = [
  {
    id: 'buzz', domain: 'conversation', displayName: 'Buzz',
    description: 'WhatsApp-first conversation layer that understands the person before handing work to a specialist.',
    priority: 100,
    capabilities: ['intent.detect', 'clarification.ask', 'conversation.context', 'reply.compose'],
    requiredSkills: [], allowedActionTypes: [], forbiddenActionTypes: ['*'], requiresHumanApprovalFor: [], enabled: true,
  },
  {
    id: 'safety', domain: 'safety', displayName: 'Safety Agent',
    description: 'Conservative safety interpretation layered above deterministic policy and below business actions.',
    priority: 95,
    capabilities: ['safety.assess', 'risk.classify', 'human.escalate'],
    requiredSkills: [], allowedActionTypes: ['maintenance.request_human_review'], forbiddenActionTypes: ['maintenance.create_work_order'], requiresHumanApprovalFor: [], enabled: true,
  },
  {
    id: 'property', domain: 'property', displayName: 'Property Agent',
    description: 'Property maintenance and operations specialist for tenants, properties, assets and vendors.',
    priority: 80,
    capabilities: ['maintenance.triage', 'property.context.read', 'work_order.prepare'],
    requiredSkills: ['property.maintenance.triage'], allowedActionTypes: ['maintenance.create_work_order', 'maintenance.request_human_review'], forbiddenActionTypes: ['lease.modify', 'payment.authorize'], requiresHumanApprovalFor: ['maintenance.create_work_order'], enabled: true,
  },
  {
    id: 'food', domain: 'food', displayName: 'Food Agent',
    description: 'WhatsApp-native ordering specialist for restaurants, food trucks, takeaways and small food businesses.',
    priority: 75,
    capabilities: ['menu.read', 'order.build', 'quantity.parse', 'modifier.capture', 'pickup_or_delivery.collect', 'order.status'],
    requiredSkills: [], allowedActionTypes: ['food.order.prepare', 'food.order.submit'], forbiddenActionTypes: ['payment.authorize', 'refund.issue'], requiresHumanApprovalFor: ['food.order.submit'], enabled: true,
  },
  {
    id: 'commerce', domain: 'commerce', displayName: 'Commerce Agent',
    description: 'Business commerce specialist for quotes, invoices, receipts, inventory and customer transactions.',
    priority: 60, capabilities: ['quote.prepare', 'invoice.prepare', 'inventory.read'], requiredSkills: [], allowedActionTypes: ['quote.prepare', 'invoice.prepare'], forbiddenActionTypes: ['payment.authorize'], requiresHumanApprovalFor: ['invoice.prepare'], enabled: true,
  },
  {
    id: 'scheduling', domain: 'scheduling', displayName: 'Scheduling Agent',
    description: 'Appointment, pickup, delivery and technician scheduling specialist.',
    priority: 55, capabilities: ['availability.read', 'appointment.prepare'], requiredSkills: [], allowedActionTypes: ['appointment.prepare'], forbiddenActionTypes: ['calendar.delete'], requiresHumanApprovalFor: [], enabled: true,
  },
  {
    id: 'research', domain: 'research', displayName: 'Research Agent',
    description: 'Bounded research and knowledge specialist for tasks that require deeper retrieval or multimodal reasoning.',
    priority: 40, capabilities: ['research', 'document.reason', 'knowledge.summarise'], requiredSkills: [], allowedActionTypes: [], forbiddenActionTypes: ['payment.authorize', 'lease.modify'], requiresHumanApprovalFor: [], enabled: true,
  },
];

for (const manifest of manifests) specialistAgentRegistry.register(manifest);
