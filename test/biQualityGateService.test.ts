import { describe, expect, it } from 'vitest';
import { validateInsight, type InsightCandidate } from '../src/services/businessIntelligence/biQualityGateService.js';
import type { ProductTopicTrend } from '../src/services/businessIntelligence/biTrendService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

function baseTrend(overrides: Partial<ProductTopicTrend> = {}): ProductTopicTrend {
  return {
    product: 'Widget X',
    topic: 'Delivery',
    sentiment: 'negative',
    currentObservationCount: 412,
    currentConversationCount: 267,
    previousObservationCount: 322,
    changePct: 28,
    direction: 'increasing',
    confidence: 'high',
    ...overrides,
  };
}

function baseCandidate(businessId: string, overrides: Partial<InsightCandidate> = {}): InsightCandidate {
  return {
    businessId,
    category: 'operations',
    title: 'Delivery complaints increased',
    body: 'Delivery complaints increased 28% over the last 30 days compared to the prior period.',
    direction: 'increasing',
    metricChangePct: 28,
    ...overrides,
  };
}

describe('biQualityGateService.validateInsight (real Postgres) - the streamlined 4-check end-of-line gate', () => {
  it('gate 1 (privacy recheck): a body that still contains real PII is held, never approved', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const result = await validateInsight(
      baseCandidate(businessId, { body: 'Delivery complaints increased 28%, e.g. from jane.doe@example.com.' }),
      baseTrend(),
    );
    expect(result.status).toBe('held');
    expect(result.qualityFlags).toContain('privacy_recheck_failed');
  });

  it('gate 2 (sample size): insufficient_data trend confidence always holds, regardless of how clean the text is', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const result = await validateInsight(baseCandidate(businessId), baseTrend({ confidence: 'insufficient_data' }));
    expect(result.status).toBe('held');
    expect(result.confidence).toBe('insufficient_data');
    expect(result.qualityFlags).toContain('insufficient_sample_size');
  });

  it('gate 3 (evidence-matches-claim): a claimed direction that disagrees with the verified trend is rejected', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const result = await validateInsight(
      baseCandidate(businessId, { direction: 'decreasing' }),
      baseTrend({ direction: 'increasing' }),
    );
    expect(result.status).toBe('rejected');
    expect(result.qualityFlags.some((f) => f.startsWith('direction_mismatch'))).toBe(true);
  });

  it('gate 3: a claimed percentage far outside the real computed number is rejected, never trusting the model\'s own arithmetic', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const result = await validateInsight(
      baseCandidate(businessId, { metricChangePct: 90 }),
      baseTrend({ changePct: 28 }),
    );
    expect(result.status).toBe('rejected');
    expect(result.qualityFlags.some((f) => f.startsWith('metric_mismatch'))).toBe(true);
  });

  it('gate 3: a claimed percentage within real, reasonable rounding tolerance of the verified number passes', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const result = await validateInsight(
      baseCandidate(businessId, { metricChangePct: 29 }),
      baseTrend({ changePct: 28 }),
    );
    expect(result.status).toBe('approved');
  });

  it('gate 4 (correlation vs causation): causal phrasing is rejected even when the numbers are otherwise correct', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const result = await validateInsight(
      baseCandidate(businessId, { body: 'Delivery complaints increased 28% because of the new courier partner.' }),
      baseTrend(),
    );
    expect(result.status).toBe('rejected');
    expect(result.qualityFlags).toContain('unsupported_causal_phrasing');
  });

  it('an insight passing all four checks is approved with no quality flags', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const result = await validateInsight(baseCandidate(businessId), baseTrend());
    expect(result.status).toBe('approved');
    expect(result.qualityFlags).toEqual([]);
    expect(result.confidence).toBe('high');
  });
});
