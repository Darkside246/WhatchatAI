/**
 * Business Intelligence Agent - insight generation. Takes
 * biTrendService.ts's own verified, deterministic numbers and asks an
 * LLM to write a short, human-readable title/body describing them -
 * matching this codebase's established `draftWithAi`-style convention:
 * the model may only describe facts it is given, never invent its own
 * numbers. Every candidate is then run through
 * biQualityGateService.validateInsight() before being written to
 * bi_insights - the model's own text NEVER reaches that table un-checked.
 */

import { queryAsTenant } from '../../db/pool.js';
import { computeProductTopicTrends, classifyRisk, type ProductTopicTrend } from './biTrendService.js';
import { validateInsight } from './biQualityGateService.js';
import { BiInsightRepository, type BiInsightCategory, type BiInsightDirection } from '../../repositories/biInsightRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { aiGateway } from '../ai/aiGateway.js';
import { pool } from '../../db/pool.js';

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

const OPERATIONS_KEYWORDS = /delivery|shipping|payment|refund|inventory|stock|support|tracking/i;
const FEEDBACK_KEYWORDS = /complaint|request|feature|feedback/i;

/** A documented, simple heuristic - not a claim of perfect categorization. Directive §29's five groupings, mapped from what's actually computable today (product + topic + direction), never a fabricated sixth category. */
function categorize(trend: ProductTopicTrend): BiInsightCategory {
  if (trend.direction === 'emerging') return 'emerging';
  if (trend.topic && OPERATIONS_KEYWORDS.test(trend.topic)) return 'operations';
  if (trend.topic && FEEDBACK_KEYWORDS.test(trend.topic)) return 'feedback';
  if (trend.product) return 'product_performance';
  return 'sentiment';
}

interface InsightDraft {
  title: string;
  body: string;
}

async function draftInsightText(businessId: string, trend: ProductTopicTrend): Promise<InsightDraft | null> {
  const facts = [
    `Product: ${trend.product ?? '(not product-specific)'}`,
    `Topic: ${trend.topic ?? '(general)'}`,
    `Sentiment: ${trend.sentiment ?? 'unclear'}`,
    `Current period observations: ${trend.currentObservationCount} (across ${trend.currentConversationCount} conversations)`,
    `Previous period observations: ${trend.previousObservationCount}`,
    `Real computed change: ${trend.changePct === null ? 'not applicable (new)' : `${trend.changePct}%`}`,
    `Real computed direction: ${trend.direction}`,
  ].join('\n');

  const systemInstruction = [
    'Write one short business-intelligence insight (a title and a one-to-two sentence body) describing the real, already-computed numbers given below.',
    'Use ONLY the numbers and direction given - never invent or adjust them, never state a different percentage or direction than what is given.',
    'Never claim the change was CAUSED by anything - describe only what the data shows (a correlation-in-time at most), never assert causation.',
    'Never name or imply any specific individual customer - this describes aggregate business activity only.',
    'Respond as a JSON object: {"title": "...", "body": "..."}.',
  ].join('\n');

  try {
    const response = await aiGateway.generate({
      tenantId: businessId,
      operation: 'bi.insight_drafting',
      responseFormat: 'json',
      maxOutputTokens: 300,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: facts },
      ],
    });
    const parsed: unknown = JSON.parse(response.text);
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as { title?: unknown }).title === 'string' &&
      typeof (parsed as { body?: unknown }).body === 'string'
    ) {
      return parsed as InsightDraft;
    }
    return null;
  } catch (error) {
    console.warn(`[biInsightService] Failed to draft insight text for business ${businessId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Generates and quality-gates one insight per real, sufficiently-evidenced
 * trend for this business/period. Skips trends still 'insufficient_data'
 * entirely (directive §18 - no insight over incorrect insight; not even
 * an attempt is made for evidence this thin). Every attempted insight is
 * written to bi_insights regardless of the gate's verdict (approved,
 * rejected, or held) - auditability over silence.
 */
export async function generateInsightsForBusiness(businessId: string, periodStart: string, periodEnd: string): Promise<{ approved: number; rejectedOrHeld: number }> {
  const trends = await computeProductTopicTrends(businessId, periodStart, periodEnd);
  const insightRepository = new BiInsightRepository(queryAsTenant(businessId));
  let approved = 0;
  let rejectedOrHeld = 0;

  for (const trend of trends) {
    if (trend.confidence === 'insufficient_data') continue;

    const draft = await draftInsightText(businessId, trend);
    if (!draft) continue;

    const category = categorize(trend);
    const direction: BiInsightDirection | null = trend.direction;

    const gateResult = await validateInsight(
      { businessId, category, title: draft.title, body: draft.body, direction, metricChangePct: trend.changePct },
      trend,
    );

    const insight = await insightRepository.create({
      businessId,
      category,
      title: draft.title,
      body: draft.body,
      direction,
      metricChangePct: trend.changePct,
      periodStart,
      periodEnd,
      evidenceObservationCount: trend.currentObservationCount,
      evidenceConversationCount: trend.currentConversationCount,
      confidence: gateResult.confidence,
      status: gateResult.status,
      qualityFlags: gateResult.qualityFlags,
      product: trend.product,
      topic: trend.topic,
      riskLevel: classifyRisk(trend),
      consecutivePeriods: trend.consecutivePeriods,
    });

    if (gateResult.status === 'approved') {
      approved += 1;
      await securityAuditLogRepository.record({ businessId, eventType: 'bi_insight_approved', rawMetadata: { insightId: insight.id, category } }).catch(() => undefined);
    } else {
      rejectedOrHeld += 1;
      await securityAuditLogRepository.record({
        businessId,
        eventType: gateResult.status === 'held' ? 'bi_insight_held' : 'bi_insight_rejected',
        rawMetadata: { insightId: insight.id, category, qualityFlags: gateResult.qualityFlags },
      }).catch(() => undefined);
    }
  }

  return { approved, rejectedOrHeld };
}
