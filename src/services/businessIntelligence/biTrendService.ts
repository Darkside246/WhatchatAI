/**
 * Business Intelligence Agent - deterministic trend math. Pure
 * application code, no LLM, per the directive's own explicit
 * instruction (§17: "use deterministic application code for numerical
 * calculations... do not rely on an LLM to perform important business
 * calculations when the application can calculate them reliably").
 *
 * Every threshold below is a stated, documented assumption - matches
 * this codebase's own established "revisit once real data exists"
 * honesty (AI Token Top-Up pricing, Learn Agent's style-signal buckets).
 */

import { queryAsTenant } from '../../db/pool.js';
import { BiObservationRepository } from '../../repositories/biObservationRepository.js';

/** Below this many real observations, a result is never published as a trend at all. */
export const MIN_SAMPLE_SIZE = 10;
/** Between MIN_SAMPLE_SIZE and this, a result may publish but only ever labeled "early signal," never a firm trend. */
export const EARLY_SIGNAL_THRESHOLD = 30;
/** How many periods back (including the immediately preceding one) consecutivePeriods will ever walk - a stated cap, not a claim of unlimited history. */
export const MAX_CONSECUTIVE_PERIOD_LOOKBACK = 6;

export type TrendConfidence = 'insufficient_data' | 'early_signal' | 'moderate' | 'high';
export type TrendDirection = 'increasing' | 'decreasing' | 'stable' | 'emerging' | 'declining' | 'anomalous';
export type TrendRiskLevel = 'low' | 'medium' | 'high';

export interface ProductTopicTrend {
  product: string | null;
  topic: string | null;
  sentiment: string | null;
  currentObservationCount: number;
  currentConversationCount: number;
  previousObservationCount: number;
  changePct: number | null;
  direction: TrendDirection;
  confidence: TrendConfidence;
  /** How many consecutive periods (starting with this one) this exact product+topic+sentiment key has had a real observation - capped at MAX_CONSECUTIVE_PERIOD_LOOKBACK + 1 (this period plus the lookback). */
  consecutivePeriods: number;
}

/**
 * Real, deterministic risk classification - informational only, never
 * cross-checked by biQualityGateService (nothing in a candidate insight
 * claims a risk level for the gate to verify against). null whenever the
 * trend's sentiment isn't negative - risk is a concept for negative
 * trends specifically.
 */
export function classifyRisk(trend: Pick<ProductTopicTrend, 'sentiment' | 'direction' | 'confidence'>): TrendRiskLevel | null {
  if (trend.sentiment !== 'negative') return null;

  const isWorsening = trend.direction === 'increasing' || trend.direction === 'emerging';
  const isStableOrAnomalous = trend.direction === 'stable' || trend.direction === 'anomalous';
  const isStrongConfidence = trend.confidence === 'moderate' || trend.confidence === 'high';

  if (isWorsening && isStrongConfidence) return 'high';
  if (isWorsening && trend.confidence === 'early_signal') return 'medium';
  if (isStableOrAnomalous && isStrongConfidence) return 'medium';
  return 'low';
}

function classifyConfidence(observationCount: number): TrendConfidence {
  if (observationCount < MIN_SAMPLE_SIZE) return 'insufficient_data';
  if (observationCount < EARLY_SIGNAL_THRESHOLD) return 'early_signal';
  if (observationCount < EARLY_SIGNAL_THRESHOLD * 3) return 'moderate';
  return 'high';
}

/** Real, deterministic direction - never guessed, never LLM-classified. */
function classifyDirection(currentCount: number, previousCount: number): TrendDirection {
  if (previousCount === 0 && currentCount > 0) return 'emerging';
  if (previousCount > 0 && currentCount === 0) return 'declining';
  if (previousCount === 0 && currentCount === 0) return 'stable';
  const changePct = ((currentCount - previousCount) / previousCount) * 100;
  if (Math.abs(changePct) < 10) return 'stable';
  return changePct > 0 ? 'increasing' : 'decreasing';
}

/**
 * Compares the current period against the immediately preceding period
 * of equal length - real period-over-period math, grouped by
 * product/topic/sentiment. Never trusts anything an LLM might have said
 * about the numbers; the caller (biQualityGateService.ts) uses this as
 * the ground truth to verify a generated insight's claim against.
 */
export async function computeProductTopicTrends(businessId: string, periodStart: string, periodEnd: string): Promise<ProductTopicTrend[]> {
  const repo = new BiObservationRepository(queryAsTenant(businessId));
  const periodLengthMs = new Date(periodEnd).getTime() - new Date(periodStart).getTime();
  const previousPeriodEnd = periodStart;
  const previousPeriodStart = new Date(new Date(periodStart).getTime() - periodLengthMs).toISOString();

  const [current, previous] = await Promise.all([
    repo.aggregateByProductTopic(businessId, periodStart, periodEnd),
    repo.aggregateByProductTopic(businessId, previousPeriodStart, previousPeriodEnd),
  ]);

  const key = (row: { product: string | null; topic: string | null; sentiment: string | null }) => `${row.product ?? ''}::${row.topic ?? ''}::${row.sentiment ?? ''}`;
  const previousByKey = new Map(previous.map((row) => [key(row), row]));

  // Consecutive-periods streak: periods 2..MAX_CONSECUTIVE_PERIOD_LOOKBACK,
  // walking further back than `previous` (period 1, already fetched above).
  // Only fetched when there's at least one current-period row to check it
  // against - never wasted queries against an empty result set.
  const olderByKeyPerPeriod = current.length === 0
    ? []
    : (
      await Promise.all(
        Array.from({ length: MAX_CONSECUTIVE_PERIOD_LOOKBACK - 1 }, (_unused, idx) => {
          const periodsBack = idx + 2;
          const start = new Date(new Date(periodStart).getTime() - periodsBack * periodLengthMs).toISOString();
          const end = new Date(new Date(periodStart).getTime() - (periodsBack - 1) * periodLengthMs).toISOString();
          return repo.aggregateByProductTopic(businessId, start, end);
        }),
      )
    ).map((rows) => new Map(rows.map((row) => [key(row), row])));

  return current.map((row) => {
    const rowKey = key(row);
    const prior = previousByKey.get(rowKey);
    const previousObservationCount = prior?.observationCount ?? 0;
    const changePct = previousObservationCount > 0
      ? Math.round(((row.observationCount - previousObservationCount) / previousObservationCount) * 1000) / 10
      : null;

    // The current period itself always counts (`current` only ever
    // contains rows with a real observation), then extend the streak back
    // one period at a time, stopping at the first genuine gap.
    let consecutivePeriods = 1;
    if (previousObservationCount > 0) {
      consecutivePeriods = 2;
      for (const byKey of olderByKeyPerPeriod) {
        const olderRow = byKey.get(rowKey);
        if (!olderRow || olderRow.observationCount <= 0) break;
        consecutivePeriods += 1;
      }
    }

    return {
      product: row.product,
      topic: row.topic,
      sentiment: row.sentiment,
      currentObservationCount: row.observationCount,
      currentConversationCount: row.conversationCount,
      previousObservationCount,
      changePct,
      direction: classifyDirection(row.observationCount, previousObservationCount),
      confidence: classifyConfidence(row.observationCount),
      consecutivePeriods,
    };
  });
}

