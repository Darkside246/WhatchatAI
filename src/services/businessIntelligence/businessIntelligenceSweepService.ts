/**
 * Business Intelligence Agent - the scheduled sweep entry point. For
 * every business that has opted in (bi_settings.enabled), runs
 * extraction across every real source, then generates and quality-gates
 * insights from the resulting observations. Per-business failure
 * isolation - one business's bad data or a transient LLM failure never
 * stops the sweep from reaching the rest, matching every other scheduled
 * sweep in this codebase.
 */

import { pool } from '../../db/pool.js';
import { BiSettingsRepository } from '../../repositories/biSettingsRepository.js';
import { extractFromChats, extractFromInvoices, extractFromDocuments, extractFromReviews } from './biExtractionService.js';
import { generateInsightsForBusiness } from './biInsightService.js';

const biSettingsRepository = new BiSettingsRepository(pool);

/** A stated, documented default - matches the scheduled sweep's own 6-hour cadence (see incomingMessagesWorker.ts). */
const ANALYSIS_WINDOW_HOURS = 24;

export async function runBusinessIntelligenceSweep(): Promise<void> {
  const enabledSettings = await biSettingsRepository.listAllEnabled();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - ANALYSIS_WINDOW_HOURS * 60 * 60 * 1000);

  for (const settings of enabledSettings) {
    try {
      await runForBusiness(settings.businessId, periodStart.toISOString(), periodEnd.toISOString());
    } catch (error) {
      console.warn(`[businessIntelligenceSweepService] Sweep failed for business ${settings.businessId}:`, error instanceof Error ? error.message : error);
    }
  }
}

async function runForBusiness(businessId: string, periodStart: string, periodEnd: string): Promise<{ approved: number; rejectedOrHeld: number }> {
  await Promise.all([
    extractFromChats(businessId, periodStart, periodEnd).catch((error) => {
      console.warn(`[businessIntelligenceSweepService] Chat extraction failed for ${businessId}:`, error instanceof Error ? error.message : error);
      return 0;
    }),
    extractFromInvoices(businessId, periodStart, periodEnd).catch((error) => {
      console.warn(`[businessIntelligenceSweepService] Invoice extraction failed for ${businessId}:`, error instanceof Error ? error.message : error);
      return 0;
    }),
    extractFromDocuments(businessId, periodStart, periodEnd).catch((error) => {
      console.warn(`[businessIntelligenceSweepService] Document extraction failed for ${businessId}:`, error instanceof Error ? error.message : error);
      return 0;
    }),
    extractFromReviews(businessId, periodStart, periodEnd).catch((error) => {
      console.warn(`[businessIntelligenceSweepService] Review extraction failed for ${businessId}:`, error instanceof Error ? error.message : error);
      return 0;
    }),
  ]);

  const result = await generateInsightsForBusiness(businessId, periodStart, periodEnd);
  await biSettingsRepository.recordRun(businessId);
  return result;
}

/** Exposed for a manual "run now" trigger (e.g. a developer verifying the pipeline against real data) - the same real work the scheduled sweep does, for one business only. */
export async function runBusinessIntelligenceForBusiness(businessId: string, windowHours = ANALYSIS_WINDOW_HOURS): Promise<{ approved: number; rejectedOrHeld: number }> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - windowHours * 60 * 60 * 1000);
  return runForBusiness(businessId, periodStart.toISOString(), periodEnd.toISOString());
}
