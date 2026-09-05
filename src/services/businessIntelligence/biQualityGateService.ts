/**
 * Business Intelligence Agent - the streamlined end-of-line quality gate
 * (per the user's own scoping decision: one real, honestly-labeled
 * validation pass covering the risks that matter most, not the
 * directive's full 10-named-gate/defect-taxonomy ceremony).
 *
 * Manufacturing principle the directive itself names: PROCESS → INSPECT
 * → VALIDATE → APPROVE → DELIVER, never PROCESS → DELIVER. Only an
 * insight passing every check below is ever marked 'approved' - anything
 * else is 'held' or 'rejected' and never reaches the Trends API.
 *
 * This does NOT guarantee zero defects, and never claims to - it
 * documents exactly what it checks so the gap between "streamlined" and
 * "exhaustive" stays honest and visible in code, not implied away.
 */

import type { BiInsightCategory, BiInsightDirection, BiInsightStatus } from '../../repositories/biInsightRepository.js';
import type { ProductTopicTrend, TrendConfidence } from './biTrendService.js';
import { redactForAnalysis } from './piiRedactionService.js';

export interface InsightCandidate {
  businessId: string;
  category: BiInsightCategory;
  title: string;
  body: string;
  direction: BiInsightDirection | null;
  metricChangePct: number | null;
}

export interface QualityGateResult {
  status: BiInsightStatus;
  confidence: TrendConfidence;
  qualityFlags: string[];
}

// Directive §21: correlation must never be presented as causation. A
// deterministic keyword scan, not an LLM judgment call - simple, fast,
// auditable, same "deterministic where the risk is real" philosophy as
// biTrendService.ts's own math.
const CAUSAL_PHRASING_PATTERNS: RegExp[] = [
  /\bcaused by\b/i,
  /\bbecause of\b/i,
  /\bdue to\b/i,
  /\bresulted in\b/i,
  /\bled to\b/i,
  /\bcausing\b/i,
];

function containsCausalPhrasing(text: string): boolean {
  return CAUSAL_PHRASING_PATTERNS.some((pattern) => pattern.test(text));
}

/** Real, deterministic map from a trend's own confidence to a pass/hold decision - never a vibe. */
function sampleSizeGate(confidence: TrendConfidence): boolean {
  return confidence !== 'insufficient_data';
}

/**
 * The one real validation function. `verifiedTrend` is biTrendService.ts's
 * own, already-computed ground truth for the same product/topic the
 * candidate insight claims to describe - the candidate's stated
 * direction/percentage is checked against it, never trusted on its own.
 */
export async function validateInsight(candidate: InsightCandidate, verifiedTrend: ProductTopicTrend): Promise<QualityGateResult> {
  const qualityFlags: string[] = [];

  // Gate 1: privacy/security recheck - defense in depth against the
  // model echoing something from its source material into the insight
  // text itself. redactForAnalysis logs its own bi_security_alerts row
  // when it finds something; this gate only needs to know whether it did.
  const redacted = await redactForAnalysis(candidate.businessId, candidate.body, 'generated_insight');
  if (redacted !== candidate.body) {
    qualityFlags.push('privacy_recheck_failed');
    return { status: 'held', confidence: verifiedTrend.confidence, qualityFlags };
  }

  // Gate 2: sample size / evidence check - real counts, never a
  // fabricated "confident enough" judgment.
  if (!sampleSizeGate(verifiedTrend.confidence)) {
    qualityFlags.push('insufficient_sample_size');
    return { status: 'held', confidence: 'insufficient_data', qualityFlags };
  }

  // Gate 3: evidence-matches-claim - the candidate's own stated
  // direction must equal what biTrendService.ts actually computed.
  // Never trusts the model's own arithmetic (directive §17/§24).
  if (candidate.direction && candidate.direction !== verifiedTrend.direction) {
    qualityFlags.push(`direction_mismatch: claimed ${candidate.direction}, verified ${verifiedTrend.direction}`);
    return { status: 'rejected', confidence: verifiedTrend.confidence, qualityFlags };
  }
  if (
    candidate.metricChangePct !== null &&
    verifiedTrend.changePct !== null &&
    Math.abs(candidate.metricChangePct - verifiedTrend.changePct) > Math.max(2, Math.abs(verifiedTrend.changePct) * 0.15)
  ) {
    qualityFlags.push(`metric_mismatch: claimed ${candidate.metricChangePct}%, verified ${verifiedTrend.changePct}%`);
    return { status: 'rejected', confidence: verifiedTrend.confidence, qualityFlags };
  }

  // Gate 4: correlation-vs-causation phrasing.
  if (containsCausalPhrasing(candidate.body)) {
    qualityFlags.push('unsupported_causal_phrasing');
    return { status: 'rejected', confidence: verifiedTrend.confidence, qualityFlags };
  }

  return { status: 'approved', confidence: verifiedTrend.confidence, qualityFlags: [] };
}
