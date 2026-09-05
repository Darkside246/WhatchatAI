import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { runGovernanceSweep } from '../src/services/governance/governanceSweepService.js';
import { GovernanceFlagRepository } from '../src/repositories/governanceFlagRepository.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const governanceFlagRepository = new GovernanceFlagRepository(pool);

/** Defaults (resetDatabase truncates platform_settings, so getGovernanceThresholds always falls back to these): toolDenialsPerHour=20, sentinelBlocksPerHour=15, outputLeaksPerHour=5. */
async function seedDeniedTools(businessId: string, agentId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await securityAuditLogRepository.record({ businessId, eventType: 'ai_tool_denied', rawMetadata: { agentId } });
  }
}

describe('governanceSweepService.runGovernanceSweep (real Postgres, AI Governance & Oversight v1)', () => {
  it('a clean business with no anomalous activity produces zero flags', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    await runGovernanceSweep();
    expect(await governanceFlagRepository.listForBusiness(businessId)).toEqual([]);
  });

  it('a count one below the default toolDenialsPerHour threshold (20) produces no flag', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    await seedDeniedTools(businessId, agent.id, 19);

    await runGovernanceSweep();
    expect(await governanceFlagRepository.listForBusiness(businessId)).toEqual([]);
  });

  it('a count at the default toolDenialsPerHour threshold (20) raises a real high_tool_denial_rate flag with the correct metric/threshold', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    await seedDeniedTools(businessId, agent.id, 20);

    await runGovernanceSweep();
    const flags = await governanceFlagRepository.listForBusiness(businessId);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.flagType).toBe('high_tool_denial_rate');
    expect(flags[0]?.agentId).toBe(agent.id);
    expect(flags[0]?.metricValue).toBe(20);
    expect(flags[0]?.thresholdValue).toBe(20);
    expect(flags[0]?.status).toBe('open');

    // A real, matching security_audit_logs event was written for this flag.
    const auditRows = await securityAuditLogRepository.listByTypeSince(businessId, 'governance_flag_raised', new Date(Date.now() - 60_000).toISOString());
    expect(auditRows).toHaveLength(1);
  });

  it('de-duplication: two consecutive sweep runs against the same still-anomalous business/agent produce exactly one open flag, not two', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    await seedDeniedTools(businessId, agent.id, 25);

    await runGovernanceSweep();
    await runGovernanceSweep(); // the condition is still true on this second tick

    const flags = await governanceFlagRepository.listForBusiness(businessId);
    expect(flags).toHaveLength(1);
  });

  it('de-duplication: once the open flag is resolved, a later sweep can raise a fresh one', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    await seedDeniedTools(businessId, agent.id, 25);

    await runGovernanceSweep();
    const [first] = await governanceFlagRepository.listForBusiness(businessId);
    const reviewerId = await createTestUser(businessId);
    await governanceFlagRepository.markReviewed(first!.id, reviewerId);

    await runGovernanceSweep(); // condition still true, but the prior flag is now resolved
    const flags = await governanceFlagRepository.listForBusiness(businessId);
    expect(flags).toHaveLength(2);
    expect(flags.filter((f) => f.status === 'open')).toHaveLength(1);
  });

  it('high_sentinel_block_rate: a count at the default threshold (15) raises a business-scoped (no agentId) warning flag', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    for (let i = 0; i < 15; i++) {
      await securityAuditLogRepository.record({ businessId, eventType: i % 2 === 0 ? 'sentinel_heuristic_block' : 'sentinel_ai_block', rawMetadata: {} });
    }

    await runGovernanceSweep();
    const flags = await governanceFlagRepository.listForBusiness(businessId);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.flagType).toBe('high_sentinel_block_rate');
    expect(flags[0]?.agentId).toBeNull();
    expect(flags[0]?.severity).toBe('warning');
  });

  it('high_output_leak_rate: a count at the default threshold (5) raises a critical, business-scoped flag', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    for (let i = 0; i < 5; i++) {
      await securityAuditLogRepository.record({ businessId, eventType: 'ai_output_leak_blocked', rawMetadata: {} });
    }

    await runGovernanceSweep();
    const flags = await governanceFlagRepository.listForBusiness(businessId);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.flagType).toBe('high_output_leak_rate');
    expect(flags[0]?.severity).toBe('critical');
  });

  it('never mixes up two different businesses\' anomalous agents', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('A');
    const businessB = await createTestBusiness('B');
    const agentA = await new AiAgentRepository(pool).create({ businessId: businessA, name: 'Agent A' });
    await seedDeniedTools(businessA, agentA.id, 20);

    await runGovernanceSweep();
    expect(await governanceFlagRepository.listForBusiness(businessA)).toHaveLength(1);
    expect(await governanceFlagRepository.listForBusiness(businessB)).toEqual([]);
  });

  it('high_agent_output_leak_rate (follow-up): a count at the default per-agent threshold (3) raises a critical, per-agent flag - reusing the existing agentId already recorded by aiOrchestrator.ts, no write-side change needed', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    for (let i = 0; i < 3; i++) {
      await securityAuditLogRepository.record({ businessId, eventType: 'ai_output_leak_blocked', rawMetadata: { agentId: agent.id } });
    }

    await runGovernanceSweep();
    const flags = await governanceFlagRepository.listForBusiness(businessId);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.flagType).toBe('high_agent_output_leak_rate');
    expect(flags[0]?.agentId).toBe(agent.id);
    expect(flags[0]?.severity).toBe('critical');
    expect(flags[0]?.metricValue).toBe(3);
  });

  it('high_agent_output_leak_rate: a count one below the default per-agent threshold produces no flag, even though the business-wide rate might still be below its own separate threshold too', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    for (let i = 0; i < 2; i++) {
      await securityAuditLogRepository.record({ businessId, eventType: 'ai_output_leak_blocked', rawMetadata: { agentId: agent.id } });
    }

    await runGovernanceSweep();
    expect(await governanceFlagRepository.listForBusiness(businessId)).toEqual([]);
  });

  it('high_agent_output_leak_rate and high_output_leak_rate are independent rules - both can fire for the same underlying events without de-duplicating against each other', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Agent' });
    // 5 leaks from one agent crosses both the per-agent threshold (3) and the business-wide threshold (5).
    for (let i = 0; i < 5; i++) {
      await securityAuditLogRepository.record({ businessId, eventType: 'ai_output_leak_blocked', rawMetadata: { agentId: agent.id } });
    }

    await runGovernanceSweep();
    const flags = await governanceFlagRepository.listForBusiness(businessId);
    expect(flags.map((f) => f.flagType).sort()).toEqual(['high_agent_output_leak_rate', 'high_output_leak_rate']);
  });
});
