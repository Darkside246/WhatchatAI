import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { createTestBusiness } from './helpers.js';

/**
 * Section 116 (audit logging): billingRoutes.ts's developer-only plan/
 * entitlement-config routes and productAccountRoutes.ts's assign-vertical
 * route previously mutated real platform state with no audit trail at
 * all. Migration 974 made security_audit_logs.business_id nullable so a
 * genuinely platform-wide event (a plan applies across every subscribed
 * business, so there's no single business_id to attach it to) can be
 * recorded without inventing a fake owner - same precedent as
 * platform_skills.business_id (a global, non-tenant skill).
 */
describe('SecurityAuditLogRepository - platform-wide events (real Postgres, migration 974)', () => {
  it('records a genuinely platform-wide event with a null businessId', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const record = await repo.record({
      businessId: null,
      eventType: 'plan_updated',
      rawMetadata: { planId: 'plan-1', changedBy: 'user-1', changes: { priceMonthlyCents: 5000 } },
    });
    expect(record.businessId).toBeNull();
    expect(record.eventType).toBe('plan_updated');
  });

  it('accepts the new plan_entitlement_updated and vertical_assigned event types', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessId = await createTestBusiness();
    await expect(repo.record({ businessId: null, eventType: 'plan_entitlement_updated', rawMetadata: {} })).resolves.toBeTruthy();
    await expect(repo.record({ businessId, eventType: 'vertical_assigned', rawMetadata: { productKey: 'retail' } })).resolves.toBeTruthy();
  });

  it('listPlatformEvents returns only the null-businessId rows, newest first', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessId = await createTestBusiness();
    await repo.record({ businessId, eventType: 'vertical_assigned', rawMetadata: {} });
    const first = await repo.record({ businessId: null, eventType: 'plan_updated', rawMetadata: { order: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.record({ businessId: null, eventType: 'plan_updated', rawMetadata: { order: 2 } });

    const events = await repo.listPlatformEvents();
    const ids = events.map((e) => e.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(events.every((e) => e.businessId === null)).toBe(true);
  });

  it('a business-scoped listRecent never returns a platform-wide event - real tenant isolation, not just a filter one caller happens to apply', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessId = await createTestBusiness();
    await repo.record({ businessId, eventType: 'vertical_assigned', rawMetadata: {} });
    await repo.record({ businessId: null, eventType: 'plan_updated', rawMetadata: {} });

    const events = await repo.listRecent(businessId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('vertical_assigned');
  });
});

describe('SecurityAuditLogRepository - governance aggregation methods (real Postgres, AI Governance & Oversight v1)', () => {
  it('countGroupedByAgentSince groups ai_tool_denied by (business, agent), ignoring rows with no agentId or too old', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const sinceIso = new Date(Date.now() - 60_000).toISOString();

    await repo.record({ businessId: businessA, eventType: 'ai_tool_denied', rawMetadata: { agentId: 'agent-1' } });
    await repo.record({ businessId: businessA, eventType: 'ai_tool_denied', rawMetadata: { agentId: 'agent-1' } });
    await repo.record({ businessId: businessA, eventType: 'ai_tool_denied', rawMetadata: { agentId: 'agent-2' } });
    await repo.record({ businessId: businessB, eventType: 'ai_tool_denied', rawMetadata: { agentId: 'agent-3' } });
    await repo.record({ businessId: businessA, eventType: 'ai_tool_denied', rawMetadata: {} }); // no agentId - excluded
    await repo.record({ businessId: businessA, eventType: 'ai_tool_invoked', rawMetadata: { agentId: 'agent-1' } }); // wrong event type - excluded

    const grouped = await repo.countGroupedByAgentSince('ai_tool_denied', sinceIso);
    const forBusinessA = grouped.filter((g) => g.businessId === businessA);
    expect(forBusinessA.find((g) => g.agentId === 'agent-1')?.count).toBe(2);
    expect(forBusinessA.find((g) => g.agentId === 'agent-2')?.count).toBe(1);
    expect(grouped.find((g) => g.businessId === businessB && g.agentId === 'agent-3')?.count).toBe(1);
  });

  it('countGroupedByAgentSince excludes rows created before the given sinceIso', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessId = await createTestBusiness();
    await repo.record({ businessId, eventType: 'ai_tool_denied', rawMetadata: { agentId: 'agent-1' } });
    const sinceIso = new Date(Date.now() + 60_000).toISOString(); // one minute in the future - nothing should match
    const grouped = await repo.countGroupedByAgentSince('ai_tool_denied', sinceIso);
    expect(grouped.find((g) => g.businessId === businessId)).toBeUndefined();
  });

  it('countGroupedByBusinessSince sums across multiple event types, grouped by business only', async () => {
    const repo = new SecurityAuditLogRepository(pool);
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const sinceIso = new Date(Date.now() - 60_000).toISOString();

    await repo.record({ businessId: businessA, eventType: 'sentinel_heuristic_block', rawMetadata: {} });
    await repo.record({ businessId: businessA, eventType: 'sentinel_ai_block', rawMetadata: {} });
    await repo.record({ businessId: businessA, eventType: 'sentinel_pass', rawMetadata: {} }); // not in the requested set - excluded
    await repo.record({ businessId: businessB, eventType: 'sentinel_heuristic_block', rawMetadata: {} });

    const grouped = await repo.countGroupedByBusinessSince(['sentinel_heuristic_block', 'sentinel_ai_block'], sinceIso);
    expect(grouped.find((g) => g.businessId === businessA)?.count).toBe(2);
    expect(grouped.find((g) => g.businessId === businessB)?.count).toBe(1);
  });
});
