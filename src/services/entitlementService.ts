import type { Queryable } from '../repositories/types.js';
import { PlanRepository } from '../repositories/planRepository.js';
import { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { CampaignRepository } from '../repositories/campaignRepository.js';
import { FunnelRepository } from '../repositories/funnelRepository.js';
import { KnowledgeBaseRepository } from '../repositories/knowledgeBaseRepository.js';
import { BusinessDocumentRepository } from '../repositories/businessDocumentRepository.js';

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
  private readonly accountRepository: WhatsAppAccountRepository;
  private readonly campaignRepository: CampaignRepository;
  private readonly funnelRepository: FunnelRepository;
  private readonly knowledgeBaseRepository: KnowledgeBaseRepository;
  private readonly businessDocumentRepository: BusinessDocumentRepository;

  constructor(private readonly db: Queryable) {
    this.planRepository = new PlanRepository(db);
    this.subscriptionRepository = new SubscriptionRepository(db);
    this.aiAgentRepository = new AiAgentRepository(db);
    this.accountRepository = new WhatsAppAccountRepository(db);
    this.campaignRepository = new CampaignRepository(db);
    this.funnelRepository = new FunnelRepository(db);
    this.knowledgeBaseRepository = new KnowledgeBaseRepository(db);
    this.businessDocumentRepository = new BusinessDocumentRepository(db);
  }

  async canCreateAgent(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_ai_agents', () =>
      this.aiAgentRepository.countActiveByBusiness(businessId),
    );
  }

  async canConnectWhatsAppAccount(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_whatsapp_accounts', () =>
      this.accountRepository.countByBusiness(businessId),
    );
  }

  async canCreateCampaign(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_active_campaigns', () =>
      this.campaignRepository.countInFlightByBusiness(businessId),
    );
  }

  async canActivateFunnel(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_active_funnels', () =>
      this.funnelRepository.countActiveByBusiness(businessId),
    );
  }

  async canCreateKnowledgeBaseDocument(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_knowledge_base_documents', () =>
      this.knowledgeBaseRepository.countByBusiness(businessId),
    );
  }

  async canCreateBusinessDocument(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_business_documents', () =>
      this.businessDocumentRepository.countByBusiness(businessId),
    );
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
