import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { getControlPlaneStats } from '../src/services/productAccountService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * The developer control-plane-stats route used to inline this exact query
 * with three real column/table mismatches (businesses.deleted_at,
 * whatsapp_accounts.status, and a "trials" table that has never existed -
 * the real table is product_trials) that only ever surfaced live, because
 * nothing ever actually executed the query: this codebase has no
 * HTTP-level route test harness at all. Extracted into
 * getControlPlaneStats() specifically so it can be tested directly.
 */
describe('getControlPlaneStats (real Postgres, real column and table names)', () => {
  it('runs cleanly against an empty database - proof every referenced table and column really exists', async () => {
    await resetDatabase();
    const stats = await getControlPlaneStats();
    expect(stats.totalBusinesses).toBe(0);
    expect(stats.activeWaConnections).toBe(0);
    expect(stats.inactiveWaConnections).toBe(0);
    expect(stats.totalAiAgents).toBe(0);
    expect(stats.activeTrials).toBe(0);
    expect(stats.recentSecurityEvents).toBe(0);
    // A real Node.js process.uptime() value, not fabricated - non-negative, not asserted to any exact number.
    expect(stats.serverUptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('counts real businesses, connected/disconnected accounts, active agents, and recent security events - never a soft-deleted row', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const connectedAccountId = await createTestAccount(businessId, '15550001111@s.whatsapp.net');
    void connectedAccountId;

    const agents = new AiAgentRepository(pool);
    await agents.create({ businessId, name: 'Real Agent' });

    await pool.query(
      `INSERT INTO security_audit_logs (business_id, event_type, severity, reason) VALUES ($1, 'sentinel_pass', 'info', 'test event')`,
      [businessId],
    );

    // A genuinely disconnected (but not soft-deleted) account counts as inactive, not active.
    const disconnectedAccountId = await createTestAccount(businessId, '15550003333@s.whatsapp.net');
    await pool.query(`UPDATE whatsapp_accounts SET connection_status = 'DISCONNECTED' WHERE id = $1`, [disconnectedAccountId]);

    // A soft-deleted account and agent must never be counted as active OR inactive.
    const deletedAccountId = await createTestAccount(businessId, '15550002222@s.whatsapp.net');
    await pool.query(`UPDATE whatsapp_accounts SET deleted_at = now() WHERE id = $1`, [deletedAccountId]);
    const deletedAgent = await agents.create({ businessId, name: 'Deleted Agent' });
    await pool.query(`UPDATE ai_agents SET deleted_at = now() WHERE id = $1`, [deletedAgent.id]);

    const stats = await getControlPlaneStats();
    expect(stats.totalBusinesses).toBe(1);
    expect(stats.activeWaConnections).toBe(1);
    expect(stats.inactiveWaConnections).toBe(1);
    expect(stats.totalAiAgents).toBe(1);
    expect(stats.recentSecurityEvents).toBe(1);
  });
});
