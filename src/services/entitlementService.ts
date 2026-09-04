import type { Queryable } from '../repositories/types.js';
import { PlanRepository } from '../repositories/planRepository.js';
import { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { CampaignRepository } from '../repositories/campaignRepository.js';
import { FunnelRepository } from '../repositories/funnelRepository.js';
import { KnowledgeBaseRepository } from '../repositories/knowledgeBaseRepository.js';
import { BusinessDocumentRepository } from '../repositories/businessDocumentRepository.js';
import { AiUsageRepository } from '../repositories/aiUsageRepository.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';

export type EntitlementDenialReason = 'NO_ACTIVE_SUBSCRIPTION' | 'ENTITLEMENT_DISABLED' | 'ENTITLEMENT_LIMIT_REACHED';
export interface EntitlementCheckResult { allowed: boolean; reason?: EntitlementDenialReason; limit?: number | null; current?: number; }

export class EntitlementService {
  private readonly planRepository: PlanRepository;
  private readonly subscriptionRepository: SubscriptionRepository;
  private readonly aiAgentRepository: AiAgentRepository;
  private readonly accountRepository: WhatsAppAccountRepository;
  private readonly campaignRepository: CampaignRepository;
  private readonly funnelRepository: FunnelRepository;
  private readonly knowledgeBaseRepository: KnowledgeBaseRepository;
  private readonly businessDocumentRepository: BusinessDocumentRepository;
  private readonly aiUsageRepository: AiUsageRepository;
  private readonly membershipRepository: BusinessMembershipRepository;

  constructor(private readonly db: Queryable) {
    this.planRepository = new PlanRepository(db);
    this.subscriptionRepository = new SubscriptionRepository(db);
    this.aiAgentRepository = new AiAgentRepository(db);
    this.accountRepository = new WhatsAppAccountRepository(db);
    this.campaignRepository = new CampaignRepository(db);
    this.funnelRepository = new FunnelRepository(db);
    this.knowledgeBaseRepository = new KnowledgeBaseRepository(db);
    this.businessDocumentRepository = new BusinessDocumentRepository(db);
    this.aiUsageRepository = new AiUsageRepository(db);
    this.membershipRepository = new BusinessMembershipRepository(db);
  }

  async checkEntitlement(businessId: string, entitlementKey: string): Promise<EntitlementCheckResult> {
    if (!businessId || !entitlementKey) return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };
    const subscription = await this.subscriptionRepository.findLiveByBusiness(businessId);
    if (!subscription) return { allowed: false, reason: 'NO_ACTIVE_SUBSCRIPTION' };
    const entitlement = await this.planRepository.getEntitlement(subscription.planId, entitlementKey);
    if (!entitlement || !entitlement.isEnabled) return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };
    return { allowed: true, limit: entitlement.limitValue };
  }

  async canCreateAgent(businessId: string): Promise<EntitlementCheckResult> { return this.checkCountLimit(businessId, 'max_ai_agents', () => this.aiAgentRepository.countActiveByBusiness(businessId)); }
  async canConnectWhatsAppAccount(businessId: string): Promise<EntitlementCheckResult> { return this.checkCountLimit(businessId, 'max_whatsapp_accounts', () => this.accountRepository.countByBusiness(businessId)); }
  async canCreateCampaign(businessId: string): Promise<EntitlementCheckResult> { return this.checkCountLimit(businessId, 'max_active_campaigns', () => this.campaignRepository.countInFlightByBusiness(businessId)); }
  async canActivateFunnel(businessId: string): Promise<EntitlementCheckResult> { return this.checkCountLimit(businessId, 'max_active_funnels', () => this.funnelRepository.countActiveByBusiness(businessId)); }
  async canCreateKnowledgeBaseDocument(businessId: string): Promise<EntitlementCheckResult> { return this.checkCountLimit(businessId, 'max_knowledge_base_documents', () => this.knowledgeBaseRepository.countByBusiness(businessId)); }
  async canCreateBusinessDocument(businessId: string): Promise<EntitlementCheckResult> { return this.checkCountLimit(businessId, 'max_business_documents', () => this.businessDocumentRepository.countByBusiness(businessId)); }
  /**
   * Section 93-98 (resource/cost mgmt): a real gap found - every other
   * seeded entitlement (max_ai_agents, max_whatsapp_accounts,
   * max_active_campaigns, max_active_funnels, the two document limits,
   * max_ai_tokens_per_month) has had a real enforcement method since it
   * was seeded, but max_users (seeded since the very first plan migration,
   * 025) never did - workspaceMemberService.ts's createMember() invited
   * team members with no entitlement check at all. countForBusiness()
   * itself was already real (businessMembershipRepository.ts), just never
   * called from anywhere outside authService.ts's own signup-time checks.
   */
  async canAddMember(businessId: string): Promise<EntitlementCheckResult> { return this.checkCountLimit(businessId, 'max_users', () => this.membershipRepository.countForBusiness(businessId)); }

  /**
   * Section 27-30 follow-up: a real per-business cumulative cap on
   * campaign-attachment storage, previously only a hardcoded per-file size
   * cap (MAX_MEDIA_BYTES) with nothing capping the running total across
   * every campaign a business has ever attached media to. Deliberately
   * not built on checkCountLimit above - that helper checks "current <
   * limit" against a count taken BEFORE the new item exists, which is
   * wrong for a cumulative byte total: a single large file could jump
   * straight from comfortably under the limit to well over it in one
   * write, so this checks "current usage + this file's real size" against
   * the limit instead.
   */
  async canStoreCampaignAttachmentBytes(businessId: string, additionalBytes: number): Promise<EntitlementCheckResult> {
    const subscription = await this.subscriptionRepository.findLiveByBusiness(businessId);
    if (!subscription) return { allowed: false, reason: 'NO_ACTIVE_SUBSCRIPTION' };
    const entitlement = await this.planRepository.getEntitlement(subscription.planId, 'max_campaign_storage_mb');
    if (!entitlement || !entitlement.isEnabled) return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };
    if (entitlement.limitValue === null) return { allowed: true };
    const currentBytes = await this.campaignRepository.sumAttachmentBytesByBusiness(businessId);
    const limitBytes = entitlement.limitValue * 1024 * 1024;
    if (currentBytes + additionalBytes <= limitBytes) return { allowed: true, limit: entitlement.limitValue, current: currentBytes };
    return { allowed: false, reason: 'ENTITLEMENT_LIMIT_REACHED', limit: entitlement.limitValue, current: currentBytes };
  }

  /**
   * Real cost-control gate - before this, no per-business ceiling on
   * actual AI usage existed anywhere: max_ai_agents caps how many agents a
   * business can *create*, nothing capped what one active agent could
   * *spend* generating real replies. checkCountLimit's own "current < limit"
   * comparison works identically for a running monthly token total as it
   * does for an agent count, so this reuses it rather than duplicating the
   * subscription/entitlement lookup.
   */
  async canUseAiThisMonth(businessId: string): Promise<EntitlementCheckResult> {
    return this.checkCountLimit(businessId, 'max_ai_tokens_per_month', () => this.aiUsageRepository.getMonthlyTotalForBusiness(businessId));
  }

  private async checkCountLimit(businessId: string, entitlementKey: string, countCurrent: () => Promise<number>): Promise<EntitlementCheckResult> {
    const subscription = await this.subscriptionRepository.findLiveByBusiness(businessId);
    if (!subscription) return { allowed: false, reason: 'NO_ACTIVE_SUBSCRIPTION' };
    const entitlement = await this.planRepository.getEntitlement(subscription.planId, entitlementKey);
    if (!entitlement || !entitlement.isEnabled) return { allowed: false, reason: 'ENTITLEMENT_DISABLED' };
    if (entitlement.limitValue === null) return { allowed: true };
    const current = await countCurrent();
    if (current < entitlement.limitValue) return { allowed: true, limit: entitlement.limitValue, current };
    return { allowed: false, reason: 'ENTITLEMENT_LIMIT_REACHED', limit: entitlement.limitValue, current };
  }
}
