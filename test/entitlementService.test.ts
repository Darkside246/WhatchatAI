import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { EntitlementService } from '../src/services/entitlementService.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { AiUsageRepository } from '../src/repositories/aiUsageRepository.js';
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

  describe('canUseAiThisMonth (real cost-control gate)', () => {
    it('allows AI usage while the starter plan\'s 500,000 token/month budget has not been reached', async () => {
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'starter');
      const usage = new AiUsageRepository(pool);
      await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 100000, candidatesTokens: 100000, totalTokens: 200000 });

      const result = await entitlements.canUseAiThisMonth(businessId);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(500000);
      expect(result.current).toBe(200000);
    });

    it('denies further AI usage once the monthly token budget is reached', async () => {
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'starter');
      const usage = new AiUsageRepository(pool);
      await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 300000, candidatesTokens: 300000, totalTokens: 600000 });

      const result = await entitlements.canUseAiThisMonth(businessId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
      expect(result.limit).toBe(500000);
    });

    it('treats a NULL plan limit as genuinely unlimited AI usage (enterprise plan)', async () => {
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'enterprise');
      const usage = new AiUsageRepository(pool);
      await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 50000000, candidatesTokens: 50000000, totalTokens: 100000000 });

      const result = await entitlements.canUseAiThisMonth(businessId);
      expect(result.allowed).toBe(true);
    });

    it('never lets one business\'s AI usage count against another business\'s budget (tenant isolation)', async () => {
      const businessA = await createTestBusiness('Business A');
      const businessB = await createTestBusiness('Business B');
      await createTestSubscription(businessA, 'starter');
      await createTestSubscription(businessB, 'starter');
      const usage = new AiUsageRepository(pool);
      await usage.record({ businessId: businessA, model: 'gemini-test', callKind: 'primary', promptTokens: 300000, candidatesTokens: 300000, totalTokens: 600000 });

      expect((await entitlements.canUseAiThisMonth(businessA)).allowed).toBe(false);
      expect((await entitlements.canUseAiThisMonth(businessB)).allowed).toBe(true);
    });
  });

  /**
   * Section 93-98: max_users has been seeded since the very first plan
   * migration (025) but had zero enforcement anywhere - every other
   * entitlement already had a real canX() method. createTestBusiness()
   * itself creates only the bare business row, no owner membership - the
   * real count starts at 0, unlike a business created via the real
   * register() signup flow (see workspaceMemberService.test.ts).
   */
  describe('canAddMember (real seat-limit enforcement)', () => {
    async function addRealMember(businessId: string, email: string): Promise<void> {
      await pool.query(
        `INSERT INTO users (email, display_name, password_hash, password_salt, password_params) VALUES ($1, 'Extra Member', 'x', 'x', '{}')`,
        [email],
      );
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      await pool.query(
        `INSERT INTO business_memberships (business_id, user_id, role, status) VALUES ($1, $2, 'AGENT', 'active')`,
        [businessId, rows[0]!.id],
      );
    }

    it('enforces the real max_users limit from the starter plan (2 users)', async () => {
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'starter');

      const first = await entitlements.canAddMember(businessId);
      expect(first.allowed).toBe(true);
      expect(first.limit).toBe(2);
      expect(first.current).toBe(0);

      await addRealMember(businessId, 'member-1@example.com');
      const second = await entitlements.canAddMember(businessId);
      expect(second.allowed).toBe(true);
      expect(second.current).toBe(1);

      await addRealMember(businessId, 'member-2@example.com');
      const third = await entitlements.canAddMember(businessId);
      expect(third.allowed).toBe(false);
      expect(third.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
      expect(third.limit).toBe(2);
      expect(third.current).toBe(2);
    });

    it('treats a NULL plan limit as genuinely unlimited seats (enterprise plan)', async () => {
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'enterprise');

      const result = await entitlements.canAddMember(businessId);
      expect(result.allowed).toBe(true);
    });
  });
});
