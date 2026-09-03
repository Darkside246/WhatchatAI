import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { AiUsageRepository } from '../src/repositories/aiUsageRepository.js';
import { CampaignRepository } from '../src/repositories/campaignRepository.js';
import { FunnelRepository } from '../src/repositories/funnelRepository.js';
import { KnowledgeBaseRepository } from '../src/repositories/knowledgeBaseRepository.js';
import { BusinessDocumentRepository } from '../src/repositories/businessDocumentRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, createTestSubscription, createTestUser, resetDatabase } from './helpers.js';

describe('workspaceService.getBillingOverview (real plan/subscription/usage, never fabricated)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('reports an honest "no subscription" state rather than fabricating a plan', async () => {
    const billing = await workspaceService.getBillingOverview(businessId);
    expect(billing.plan).toBeNull();
    expect(billing.subscription).toBeNull();
    expect(billing.entitlements).toEqual([]);
  });

  it('returns the real plan, subscription dates, and real usage counts once subscribed', async () => {
    await createTestSubscription(businessId, 'starter');
    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Agent 1' });

    const billing = await workspaceService.getBillingOverview(businessId);

    expect(billing.plan?.planKey).toBe('starter');
    expect(billing.subscription?.status).toBe('TRIALING');
    expect(billing.subscription?.trialEndsAt).toBeTruthy();

    const agentEntitlement = billing.entitlements.find((e) => e.key === 'max_ai_agents');
    expect(agentEntitlement?.limit).toBe(2);
    expect(agentEntitlement?.current).toBe(1);

    const accountEntitlement = billing.entitlements.find((e) => e.key === 'max_whatsapp_accounts');
    expect(accountEntitlement?.current).toBe(0);
  });

  it('reflects a genuinely new WhatsApp account connection in real usage', async () => {
    await createTestSubscription(businessId, 'starter');
    await createTestAccount(businessId, '15550008888@s.whatsapp.net');

    const billing = await workspaceService.getBillingOverview(businessId);
    const accountEntitlement = billing.entitlements.find((e) => e.key === 'max_whatsapp_accounts');
    expect(accountEntitlement?.current).toBe(1);
    expect(accountEntitlement?.limit).toBe(1);
  });

  it('leaves current usage null for an entitlement with no real counted backing source (max_users)', async () => {
    await createTestSubscription(businessId, 'starter');
    const billing = await workspaceService.getBillingOverview(businessId);

    const usersEntitlement = billing.entitlements.find((e) => e.key === 'max_users');
    expect(usersEntitlement).toBeDefined();
    expect(usersEntitlement?.current).toBeNull();
  });

  it('reports real AI token usage against the plan\'s monthly budget (Section 34-40 cost control)', async () => {
    await createTestSubscription(businessId, 'starter');
    const usage = new AiUsageRepository(pool);
    await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 1000, candidatesTokens: 500, totalTokens: 1500 });

    const billing = await workspaceService.getBillingOverview(businessId);
    const tokenEntitlement = billing.entitlements.find((e) => e.key === 'max_ai_tokens_per_month');
    expect(tokenEntitlement?.limit).toBe(500000);
    expect(tokenEntitlement?.current).toBe(1500);
  });

  it('reports real active-campaign, active-funnel, and document counts (previously only agents/accounts were wired up)', async () => {
    await createTestSubscription(businessId, 'starter');
    const accountId = await createTestAccount(businessId);
    const userId = await createTestUser(businessId);

    const campaigns = new CampaignRepository(pool);
    await campaigns.create({ businessId, whatsappAccountId: accountId, createdBy: userId, name: 'Campaign 1', messageText: 'Hi' });

    const funnels = new FunnelRepository(pool);
    const funnel = await funnels.create({ businessId, whatsappAccountId: accountId, createdBy: userId, name: 'Funnel 1', description: null });
    await funnels.setActive(funnel.id, true); // funnel_definitions.is_active defaults to false on creation

    const knowledgeBase = new KnowledgeBaseRepository(pool);
    await knowledgeBase.create({ businessId, createdBy: userId, title: 'Doc 1', content: 'Some content' });

    const businessDocuments = new BusinessDocumentRepository(pool);
    await businessDocuments.create({ businessId, createdBy: userId, filename: 'invoice.pdf' });

    const billing = await workspaceService.getBillingOverview(businessId);

    expect(billing.entitlements.find((e) => e.key === 'max_active_campaigns')?.current).toBe(1);
    expect(billing.entitlements.find((e) => e.key === 'max_active_funnels')?.current).toBe(1);
    expect(billing.entitlements.find((e) => e.key === 'max_knowledge_base_documents')?.current).toBe(1);
    expect(billing.entitlements.find((e) => e.key === 'max_business_documents')?.current).toBe(1);
  });

  it('never leaks another business\' usage into this business\' billing overview', async () => {
    await createTestSubscription(businessId, 'starter');
    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Agent 1' });

    const otherBusinessId = await createTestBusiness('Other Business');
    await createTestSubscription(otherBusinessId, 'starter');

    const otherBilling = await workspaceService.getBillingOverview(otherBusinessId);
    const agentEntitlement = otherBilling.entitlements.find((e) => e.key === 'max_ai_agents');
    expect(agentEntitlement?.current).toBe(0);
  });
});
