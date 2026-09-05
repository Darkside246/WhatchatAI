/**
 * Business Intelligence Agent - the small service backing the Settings/
 * Agents-page toggle and the Trends API. Wraps BiSettingsRepository (the
 * fail-closed-by-default per-business opt-in) and BiInsightRepository's
 * already-approved, already-quality-gated rows - this file never runs
 * analysis itself, that's businessIntelligenceSweepService.ts's job.
 */

import { queryAsTenant } from '../../db/pool.js';
import { BiSettingsRepository } from '../../repositories/biSettingsRepository.js';
import { BiInsightRepository, type BiInsightCategory, type BiInsightRecord } from '../../repositories/biInsightRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';

const ALL_CATEGORIES: BiInsightCategory[] = ['sentiment', 'product_performance', 'feedback', 'emerging', 'operations'];

export interface BiStats {
  enabled: boolean;
  lastRunAt: string | null;
}

export async function getBusinessIntelligenceStats(businessId: string): Promise<BiStats> {
  const repository = new BiSettingsRepository(queryAsTenant(businessId));
  const settings = await repository.get(businessId);
  return { enabled: settings?.enabled ?? false, lastRunAt: settings?.lastRunAt ?? null };
}

export async function setBusinessIntelligenceEnabled(businessId: string, enabled: boolean): Promise<BiStats> {
  const repository = new BiSettingsRepository(queryAsTenant(businessId));
  const settings = await repository.setEnabled(businessId, enabled);
  const auditLogRepository = new SecurityAuditLogRepository(queryAsTenant(businessId));
  await auditLogRepository
    .record({ businessId, eventType: enabled ? 'bi_settings_enabled' : 'bi_settings_disabled', rawMetadata: {} })
    .catch(() => undefined);
  return { enabled: settings.enabled, lastRunAt: settings.lastRunAt };
}

export type ApprovedInsightsByCategory = Record<BiInsightCategory, BiInsightRecord[]>;

/** Only ever reads status='approved' rows - the Trends API never sees a held/rejected/processing insight. */
export async function getApprovedInsightsByCategory(businessId: string): Promise<ApprovedInsightsByCategory> {
  const repository = new BiInsightRepository(queryAsTenant(businessId));
  const insights = await repository.listApproved(businessId, 200);
  const byCategory = Object.fromEntries(ALL_CATEGORIES.map((category) => [category, [] as BiInsightRecord[]])) as ApprovedInsightsByCategory;
  for (const insight of insights) {
    byCategory[insight.category].push(insight);
  }
  return byCategory;
}
