import type { Queryable } from '../../repositories/types.js';
import { EntitlementService, type EntitlementCheckResult } from '../entitlementService.js';
import { moduleRegistry } from './moduleRegistry.js';

export class ModuleEntitlementService {
  private readonly entitlements: EntitlementService;

  constructor(db: Queryable) { this.entitlements = new EntitlementService(db); }

  async check(businessId: string, moduleId: string): Promise<EntitlementCheckResult> {
    const module = moduleRegistry.get(moduleId);
    if (!module) return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };
    for (const key of module.entitlements) {
      const result = await this.entitlements.checkEntitlement(businessId, key);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  }
}
