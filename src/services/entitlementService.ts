import type { Queryable } from '../repositories/types.js';
import { PlanRepository } from '../repositories/planRepository.js';
import { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';

export type EntitlementDenialReason =
  | 'NO_ACTIVE_SUBSCRIPTION'
  | 'ENTITLEMENT_DISABLED'
  | 'ENTITLEMENT_LIMIT_REACHED';

export interface EntitlementCheckResult {
  allowed: boolean;
  reason?: EntitlementDenialReason;
  limit?: number | null;
  current?: number;
}

/**
 * Server-side entitlement enforcement. The UI may also hide/disable controls
 * for a nicer experience, but every mutating operation must call this - a
 * hidden button is not enforcement, only this is.
 */
export class EntitlementService {
  private readonly planRepository: PlanRepository;
  private readonly subscriptionRepository: SubscriptionRepository;
  private readonly aiAgentRepository: AiAgentRepository;

  constructor(private readonly db: Queryable) {
    this.planRepository = new PlanRepository(db);
    this.subscriptionRepository = new SubscriptionRepository(db);
    this.aiAgentRepository = new AiAgentRepository(db);
  }

  async canCreateAgent(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_ai_agents', () =>
      this.aiAgentRepository.countActiveByBusiness(businessId),
    );
  }

  async canConnectWhatsAppAccount(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_whatsapp_accounts', async () => {
      const { rows } = await this.db.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM whatsapp_accounts WHERE business_id = $1 AND deleted_at IS NULL`,
        [businessId],
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  private async checkCountLimit(
    businessId: string,
    entitlementKey: string,
    countCurrent: () => Promise<number>,
  ): Promise<EntitlementCheckResult> {
    const subscription = await this.subscriptionRepository.findLiveByBusiness(businessId);
    if (!subscription) return { allowed: false, reason: 'NO_ACTIVE_SUBSCRIPTION' };

    const entitlement = await this.planRepository.getEntitlement(subscription.planId, entitlementKey);
    if (!entitlement || !entitlement.isEnabled) {
      return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };
    }

    if (entitlement.limitValue === null) return { allowed: true };

    const current = await countCurrent();
    if (current < entitlement.limitValue) return { allowed: true, limit: entitlement.limitValue, current };
    return { allowed: false, reason: 'ENTITLEMENT_LIMIT_REACHED', limit: entitlement.limitValue, current };
  }
}
