import type { Queryable } from '../../repositories/types.js';
import { EntitlementService, type EntitlementCheckResult } from '../entitlementService.js';
import { moduleRegistry } from './moduleRegistry.js';

export class ModuleEntitlementService {
  private readonly entitlements: EntitlementService;

  constructor(db: Queryable) {
    this.entitlements = new EntitlementService(db);
  }

  async check(businessId: string, moduleId: string): Promise<EntitlementCheckResult> {
    const module = moduleRegistry.get(moduleId);
    if (!module) return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };

    const checks = await Promise.all(module.entitlements.map(async (key) => {
      // Module entitlements are represented through plan keys. Existing plans
      // can enable a module without introducing another billing subsystem.
      return this.checkKey(businessId, key);
    }));

    const denied = checks.find((result) => !result.allowed);
    return denied ?? { allowed: true };
  }

  private async checkKey(businessId: string, key: string): Promise<EntitlementCheckResult> {
    // EntitlementService's current public API is operation-specific. For the
    // generic module key, query plan/subscription tables directly while still
    // using the same server-side source of truth.
    const subscription = await this.entitlements['subscriptionRepository'].findLiveByBusiness(businessId);
    if (!subscription) return { allowed: false, reason: 'NO_ACTIVE_SUBSCRIPTION' };
    const entitlement = await this.entitlements['planRepository'].getEntitlement(subscription.planId, key);
    if (!entitlement || !entitlement.isEnabled) return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };
    return { allowed: true, limit: entitlement.limitValue };
  }
}
