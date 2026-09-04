import { z } from 'zod';

const ModuleManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  entitlements: z.array(z.string().min(1)).max(100),
  skillIds: z.array(z.string().min(1)).max(100),
  routePrefix: z.string().regex(/^\/[a-z0-9][a-z0-9\-/]*$/).optional(),
  enabledByDefault: z.boolean(),
});

export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export class ModuleRegistry {
  private readonly modules = new Map<string, ModuleManifest>();

  register(module: ModuleManifest): ModuleManifest {
    const parsed = ModuleManifestSchema.parse(module);
    if (this.modules.has(parsed.id)) throw new Error(`module ${parsed.id} is already registered`);
    this.modules.set(parsed.id, parsed);
    return parsed;
  }

  get(id: string): ModuleManifest | null {
    return this.modules.get(id) ?? null;
  }

  list(): ModuleManifest[] {
    return [...this.modules.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  clear(): void {
    this.modules.clear();
  }
}

export const moduleRegistry = new ModuleRegistry();

export const propertyOperationsModule: ModuleManifest = {
  id: 'property.operations',
  version: '1.0.0',
  name: 'Property Operations',
  description: 'Operational workflows for property, villa, guest, maintenance and vendor coordination.',
  entitlements: ['property.operations'],
  skillIds: ['property.maintenance.triage'],
  routePrefix: '/property-operations',
  enabledByDefault: false,
};

export const retailOperationsModule: ModuleManifest = {
  id: 'retail.operations',
  version: '1.0.0',
  name: 'Retail Operations',
  description: 'Operational workflows for retail product catalog, order intake and fulfillment.',
  entitlements: ['retail.operations'],
  skillIds: ['retail.order.triage'],
  routePrefix: '/retail-operations',
  enabledByDefault: false,
};
