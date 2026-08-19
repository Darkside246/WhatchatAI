import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { EntitlementService } from '../src/services/entitlementService.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestAccount, createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

describe('EntitlementService (real backend enforcement, not UI-only)', () => {
  let entitlements: EntitlementService;

  beforeEach(async () => {
    await resetDatabase();
    entitlements = new EntitlementService(pool);
  });

  it('denies any entitlement check for a business with no subscription at all', async () => {
    const businessId = await createTestBusiness();
    const result = await entitlements.canCreateAgent(businessId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('NO_ACTIVE_SUBSCRIPTION');
  });

  it('enforces the real max_ai_agents limit from the starter plan (2 agents)', async () => {
    const businessId = await createTestBusiness();
    await createTestSubscription(businessId, 'starter');
    const agents = new AiAgentRepository(pool);

    const first = await entitlements.canCreateAgent(businessId);
    expect(first.allowed).toBe(true);
    await agents.create({ businessId, name: 'Agent 1' });

    const second = await entitlements.canCreateAgent(businessId);
    expect(second.allowed).toBe(true);
    await agents.create({ businessId, name: 'Agent 2' });

    const third = await entitlements.canCreateAgent(businessId);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
    expect(third.limit).toBe(2);
    expect(third.current).toBe(2);
  });

  it('enforces the real max_whatsapp_accounts limit from the starter plan (1 account)', async () => {
    const businessId = await createTestBusiness();
    await createTestSubscription(businessId, 'starter');

    const before = await entitlements.canConnectWhatsAppAccount(businessId);
    expect(before.allowed).toBe(true);

    await createTestAccount(businessId, '15550005555@s.whatsapp.net');

    const after = await entitlements.canConnectWhatsAppAccount(businessId);
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
  });

  it('never enforces a limit against a different business (tenant isolation)', async () => {
    const businessA = await createTestBusiness('Business A');
    const businessB = await createTestBusiness('Business B');
    await createTestSubscription(businessA, 'starter');
    await createTestSubscription(businessB, 'starter');

    await createTestAccount(businessA, '15550006666@s.whatsapp.net');

    const businessAResult = await entitlements.canConnectWhatsAppAccount(businessA);
    const businessBResult = await entitlements.canConnectWhatsAppAccount(businessB);

    expect(businessAResult.allowed).toBe(false); // A is at its limit of 1
    expect(businessBResult.allowed).toBe(true); // B has no accounts yet, unaffected by A
  });

  it('treats a NULL plan limit as genuinely unlimited (enterprise plan)', async () => {
    const businessId = await createTestBusiness();
    await createTestSubscription(businessId, 'enterprise');
    const agents = new AiAgentRepository(pool);

    for (let i = 0; i < 10; i += 1) {
      await agents.create({ businessId, name: `Agent ${i}` });
    }

    const result = await entitlements.canCreateAgent(businessId);
    expect(result.allowed).toBe(true);
  });
});
