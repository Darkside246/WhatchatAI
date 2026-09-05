import { describe, expect, it } from 'vitest';
import { queryAsTenant } from '../src/db/pool.js';
import { BiInsightRepository } from '../src/repositories/biInsightRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Migration 1003: bi_insights gained product/topic/risk_level/consecutive_periods.
 * This is the first dedicated repository test for BiInsightRepository - covers
 * the full round-trip of the new fields plus their real defaults, since no
 * repository test existed for this table before.
 */

function baseInsightInput(businessId: string) {
  return {
    businessId,
    category: 'sentiment' as const,
    title: 'Negative mentions of Widget X rising',
    body: 'Real, computed increase over the prior period.',
    direction: 'increasing' as const,
    metricChangePct: 37,
    periodStart: '2024-01-02T00:00:00.000Z',
    periodEnd: '2024-01-16T00:00:00.000Z',
    evidenceObservationCount: 40,
    evidenceConversationCount: 35,
    confidence: 'high' as const,
    status: 'approved' as const,
    qualityFlags: [],
  };
}

describe('BiInsightRepository (real Postgres) - risk-level classification + recurring-issue fields', () => {
  it('round-trips product/topic/riskLevel/consecutivePeriods exactly as given', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new BiInsightRepository(queryAsTenant(businessId));

    const created = await repository.create({
      ...baseInsightInput(businessId),
      product: 'Widget X',
      topic: 'Packaging damage',
      riskLevel: 'high',
      consecutivePeriods: 3,
    });

    expect(created.product).toBe('Widget X');
    expect(created.topic).toBe('Packaging damage');
    expect(created.riskLevel).toBe('high');
    expect(created.consecutivePeriods).toBe(3);

    const [approved] = await repository.listApproved(businessId);
    expect(approved?.product).toBe('Widget X');
    expect(approved?.topic).toBe('Packaging damage');
    expect(approved?.riskLevel).toBe('high');
    expect(approved?.consecutivePeriods).toBe(3);
  });

  it('defaults riskLevel to null and consecutivePeriods to 1 when not given - a positive/neutral trend never gets a fabricated risk level', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new BiInsightRepository(queryAsTenant(businessId));

    const created = await repository.create(baseInsightInput(businessId));

    expect(created.product).toBeNull();
    expect(created.topic).toBeNull();
    expect(created.riskLevel).toBeNull();
    expect(created.consecutivePeriods).toBe(1);
  });

  it('riskLevel is constrained to low/medium/high/null at the database level', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repository = new BiInsightRepository(queryAsTenant(businessId));

    await expect(
      repository.create({
        ...baseInsightInput(businessId),
        // @ts-expect-error - deliberately invalid, proving the CHECK constraint is real
        riskLevel: 'catastrophic',
      }),
    ).rejects.toThrow();
  });
});
