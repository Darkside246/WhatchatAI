import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

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
