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

export type TrendConfidence = 'insufficient_data' | 'early_signal' | 'moderate' | 'high';
export type TrendDirection = 'increasing' | 'decreasing' | 'stable' | 'emerging' | 'declining' | 'anomalous';

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

  return current.map((row) => {
    const prior = previousByKey.get(key(row));
    const previousObservationCount = prior?.observationCount ?? 0;
    const changePct = previousObservationCount > 0
      ? Math.round(((row.observationCount - previousObservationCount) / previousObservationCount) * 1000) / 10
      : null;

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
    };
  });
}

