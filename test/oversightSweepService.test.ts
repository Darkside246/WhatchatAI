import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { runOversightSweep } from '../src/services/oversight/oversightSweepService.js';
import { OversightFindingRepository } from '../src/repositories/oversightFindingRepository.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { PlatformSettingsRepository } from '../src/repositories/platformSettingsRepository.js';
import { createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

const oversightFindingRepository = new OversightFindingRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const platformSettingsRepository = new PlatformSettingsRepository(pool);

// checkApplicationHealth (called on every runOversightSweep()) composes the
// real getSystemHealth(), which includes a real Goose reachability check -
// this environment's own .env has a real GOOSE_SERVICE_URL configured with
// nothing actually listening there, so every sweep call would otherwise
// eat a real, bounded-but-real 5s timeout. Same fix systemHealthService.test.ts
// already established for this exact environment quirk.
let originalGooseUrl: string | undefined;
beforeEach(() => {
  originalGooseUrl = process.env.GOOSE_SERVICE_URL;
  delete process.env.GOOSE_SERVICE_URL;
});
afterEach(() => {
  if (originalGooseUrl !== undefined) process.env.GOOSE_SERVICE_URL = originalGooseUrl;
});

async function findingsByType(findingType: string) {
  const all = await oversightFindingRepository.listOpenAcrossPlatform();
  return all.filter((f) => f.findingType === findingType);
}

describe('oversightSweepService.runOversightSweep (real Postgres, AURA AI Oversight & Reliability Agent)', () => {
  it('a clean platform with no anomalous activity produces zero non-monitoring-gap findings', async () => {
    await resetDatabase();
    await runOversightSweep();
    const all = await oversightFindingRepository.listOpenAcrossPlatform();
    expect(all.filter((f) => f.category !== 'monitoring_gap')).toEqual([]);
  });

  it('auth_abuse_spike: a count one below the default threshold (30) produces no finding, at/above it does', async () => {
    await resetDatabase();
    for (let i = 0; i < 29; i++) {
      await securityAuditLogRepository.record({ businessId: null, eventType: 'auth_rate_limited', rawMetadata: {} });
    }
    await runOversightSweep();
    expect(await findingsByType('auth_abuse_spike')).toEqual([]);

    await securityAuditLogRepository.record({ businessId: null, eventType: 'auth_rate_limited', rawMetadata: {} });
    await runOversightSweep();
    const findings = await findingsByType('auth_abuse_spike');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe('abuse_spam');
    expect((findings[0]?.evidence as { count?: number }).count).toBe(30);
  });

  it('recaptcha_failure_spike: a count at the default threshold (20) raises a real finding', async () => {
    await resetDatabase();
    for (let i = 0; i < 20; i++) {
      await securityAuditLogRepository.record({ businessId: null, eventType: 'signup_recaptcha_failed', rawMetadata: {} });
    }
    await runOversightSweep();
    expect(await findingsByType('recaptcha_failure_spike')).toHaveLength(1);
  });

  it('de-duplication: two consecutive sweeps against the same still-triggering condition produce exactly one open finding, with occurrence_count incremented', async () => {
    await resetDatabase();
    for (let i = 0; i < 40; i++) {
      await securityAuditLogRepository.record({ businessId: null, eventType: 'auth_rate_limited', rawMetadata: {} });
    }
    await runOversightSweep();
    await runOversightSweep();
    const findings = await findingsByType('auth_abuse_spike');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.occurrenceCount).toBe(2);
  });

  it('ai_usage_growth: a real, sustained week-over-week increase past the default 50% threshold raises a finding, computed from real timestamped ai_usage_events (never fabricated)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    // Prior 7-day window (days -13..-7): 1000 tokens total. Last 7-day window (days -6..0): 1600 tokens - a real 60% increase.
    for (let daysAgo = 13; daysAgo >= 7; daysAgo--) {
      await pool.query(
        `INSERT INTO ai_usage_events (business_id, model, call_kind, prompt_tokens, candidates_tokens, total_tokens, created_at) VALUES ($1, 'gemini-3.5-flash-lite', 'primary', 100, 43, 143, now() - ($2 || ' days')::interval)`,
        [businessId, daysAgo],
      );
    }
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      await pool.query(
        `INSERT INTO ai_usage_events (business_id, model, call_kind, prompt_tokens, candidates_tokens, total_tokens, created_at) VALUES ($1, 'gemini-3.5-flash-lite', 'primary', 160, 69, 229, now() - ($2 || ' days')::interval)`,
        [businessId, daysAgo],
      );
    }

    await runOversightSweep();
    const findings = await findingsByType('ai_usage_growth');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe('capacity');
  });

  it('entitlement_near_limit: a business at 90% of its plan\'s real AI token limit (starter: 500,000) raises a finding naming it', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness('Near-Limit Co');
    await createTestSubscription(businessId, 'starter');
    // 450,000 / 500,000 = 90%, past the default 80% warning threshold.
    await pool.query(
      `INSERT INTO ai_usage_events (business_id, model, call_kind, prompt_tokens, candidates_tokens, total_tokens) VALUES ($1, 'gemini-3.5-flash-lite', 'primary', 315000, 135000, 450000)`,
      [businessId],
    );

    await runOversightSweep();
    const findings = await findingsByType('entitlement_near_limit');
    expect(findings).toHaveLength(1);
    const evidence = findings[0]?.evidence as { businesses?: Array<{ businessName: string; ratio: number }> };
    expect(evidence.businesses?.[0]?.businessName).toBe('Near-Limit Co');
    expect(evidence.businesses?.[0]?.ratio).toBe(90);
  });

  it('entitlement_near_limit: a business well under its limit is never named', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness('Comfortable Co');
    await createTestSubscription(businessId, 'starter');
    await pool.query(
      `INSERT INTO ai_usage_events (business_id, model, call_kind, prompt_tokens, candidates_tokens, total_tokens) VALUES ($1, 'gemini-3.5-flash-lite', 'primary', 7000, 3000, 10000)`,
      [businessId],
    );
    await runOversightSweep();
    expect(await findingsByType('entitlement_near_limit')).toEqual([]);
  });

  it('config_left_on_too_long: maintenance_mode left enabled past the default 24h grace period raises a real, high-severity finding', async () => {
    await resetDatabase();
    await platformSettingsRepository.set('maintenance_mode', true, null);
    // Backdate updated_at to 25 hours ago - past the default configDriftGraceHours (24).
    await pool.query(`UPDATE platform_settings SET updated_at = now() - interval '25 hours' WHERE key = 'maintenance_mode'`);

    await runOversightSweep();
    const findings = await findingsByType('config_left_on_too_long');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.affectedComponent).toBe('maintenance_mode');
  });

  it('config_left_on_too_long: a setting enabled well within the grace period raises nothing', async () => {
    await resetDatabase();
    await platformSettingsRepository.set('registration_paused', true, null);
    await runOversightSweep();
    expect(await findingsByType('config_left_on_too_long')).toEqual([]);
  });

  it('monitoring gaps are always present (informational), and repeated sweeps bump occurrence_count rather than duplicating', async () => {
    await resetDatabase();
    await runOversightSweep();
    await runOversightSweep();

    const all = await oversightFindingRepository.listOpenAcrossPlatform({ category: 'monitoring_gap' });
    const gapTypes = ['monitoring_gap_network_exposure', 'monitoring_gap_tenant_memory', 'monitoring_gap_latency', 'monitoring_gap_openclaw'];
    for (const type of gapTypes) {
      const matches = all.filter((f) => f.findingType === type);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.severity).toBe('informational');
      expect(matches[0]?.occurrenceCount).toBe(2);
    }
  });

  it('capacity forecasting reports nothing until at least 8 real samples exist - never a fabricated projection from a partial window', async () => {
    await resetDatabase();
    await runOversightSweep(); // records only 1 real sample this run
    expect(await findingsByType('queue_backlog_trend')).toEqual([]);
  });
});
