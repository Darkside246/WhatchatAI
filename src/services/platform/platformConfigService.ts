import { pool } from '../../db/pool.js';
import { PlatformSettingsRepository } from '../../repositories/platformSettingsRepository.js';
// Type-only import - erased at compile time, so this does not create a
// runtime circular dependency even though aiTokenTopupService.ts imports
// a function (value) from this file below. The fallback-to-hardcoded-
// default logic stays in aiTokenTopupService.ts, not here.
import type { AiTokenTopupCatalog } from '../billing/aiTokenTopupService.js';
import type { AiMemoryTopupCatalog } from '../billing/aiMemoryTopupService.js';

const platformSettingsRepository = new PlatformSettingsRepository(pool);

/**
 * Typed wrappers around the generic `platform_settings` key/value store
 * (platformSettingsRepository.ts) for the Developer Master Control page's
 * new live toggles - same reuse-the-generic-store pattern already proven
 * by the autonomy kill switch (autonomousOpsService.ts) and payment
 * provider enable/disable (paymentProviderStatusService.ts). Every getter
 * defaults to today's real, pre-existing behavior when nothing has been
 * set yet, so none of this changes anything until a developer explicitly
 * uses the new page.
 */

export async function isGooseFallbackEnabled(): Promise<boolean> {
  const setting = await platformSettingsRepository.get('goose_fallback_enabled');
  if (!setting) return true;
  return (setting.value as { enabled?: unknown }).enabled !== false;
}

export async function setGooseFallbackEnabled(enabled: boolean, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('goose_fallback_enabled', { enabled }, updatedByUserId);
}

export async function isRegistrationPaused(): Promise<boolean> {
  const setting = await platformSettingsRepository.get('registration_paused');
  if (!setting) return false;
  return (setting.value as { enabled?: unknown }).enabled === true;
}

export async function setRegistrationPaused(enabled: boolean, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('registration_paused', { enabled }, updatedByUserId);
}

/**
 * A DEVELOPER's own request always bypasses this (see the maintenance
 * middleware in server/index.ts) - the toggle can never lock out the
 * person who flipped it on, since this same Control Plane page is itself
 * a `/api/developer/*` route.
 */
export async function isMaintenanceModeOn(): Promise<boolean> {
  const setting = await platformSettingsRepository.get('maintenance_mode');
  if (!setting) return false;
  return (setting.value as { enabled?: unknown }).enabled === true;
}

export async function setMaintenanceMode(enabled: boolean, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('maintenance_mode', { enabled }, updatedByUserId);
}

/** Read at signup time only (trialService.ts's startTrial) - changing this only affects new signups going forward, never a trial already in progress. */
export async function getTrialDurationHours(): Promise<number> {
  const setting = await platformSettingsRepository.get('trial_duration_hours');
  if (!setting) return 48;
  const hours = (setting.value as { hours?: unknown }).hours;
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : 48;
}

export async function setTrialDurationHours(hours: number, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('trial_duration_hours', { hours }, updatedByUserId);
}

/** Not a secret - just a model name - so unlike GEMINI_API_KEY this is safe to make live-editable. Null (the default) falls through to providerAdapters.ts's existing env-var chain untouched. */
export async function getGeminiModelOverride(): Promise<string | null> {
  const setting = await platformSettingsRepository.get('gemini_model_override');
  if (!setting) return null;
  const model = (setting.value as { model?: unknown }).model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

export async function setGeminiModelOverride(model: string | null, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('gemini_model_override', { model: model?.trim() || null }, updatedByUserId);
}

/** Null until a developer explicitly overrides it - the caller (aiTokenTopupService.ts's getTopupOffer) applies its own hardcoded TOPUP_CATALOG as the fallback, so this file never regresses that already-shipped upsell flow. */
export async function getAiTokenTopupCatalogOverride(): Promise<AiTokenTopupCatalog | null> {
  const setting = await platformSettingsRepository.get('ai_token_topup_catalog');
  return setting ? (setting.value as AiTokenTopupCatalog) : null;
}

export async function setAiTokenTopupCatalog(catalog: AiTokenTopupCatalog, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('ai_token_topup_catalog', catalog, updatedByUserId);
}

/** Null until a developer explicitly overrides it - the caller (aiMemoryTopupService.ts's getMemoryTopupOffer) applies its own hardcoded MEMORY_TOPUP_CATALOG as the fallback, so this file never regresses that already-shipped upsell flow. */
export async function getAiMemoryTopupCatalogOverride(): Promise<AiMemoryTopupCatalog | null> {
  const setting = await platformSettingsRepository.get('ai_memory_topup_catalog');
  return setting ? (setting.value as AiMemoryTopupCatalog) : null;
}

export async function setAiMemoryTopupCatalog(catalog: AiMemoryTopupCatalog, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('ai_memory_topup_catalog', catalog, updatedByUserId);
}

/**
 * AI Governance & Oversight (v1): the three threshold rules
 * governanceSweepService.ts evaluates every 30 minutes over a rolling
 * 1-hour window. Defaults below are a stated assumption to revisit once
 * the sweep has run against real production traffic - same honesty
 * convention as the AI Token Top-Up pricing comment: a single denied tool
 * call is routine, but ~1 every 3 minutes sustained for a full hour (20)
 * is a real agent/config problem; Sentinel blocks are already rare for a
 * healthy business (15); output leaks get the lowest threshold (5) since
 * a leak reaching that check is the most severe signal of the three.
 */
export interface GovernanceThresholds {
  toolDenialsPerHour: number;
  sentinelBlocksPerHour: number;
  outputLeaksPerHour: number;
  /** Follow-up: a lower threshold than the business-wide outputLeaksPerHour above - one specific agent repeatedly leaking is a more concentrated, more concerning signal than leaks spread across a business's several agents. Made cheap by a real discovery: aiOrchestrator.ts's guardGeneratedText already records agentId on every ai_output_leak_blocked event, so no write-side change was needed to add this rule. */
  outputLeaksPerAgentPerHour: number;
}

const DEFAULT_GOVERNANCE_THRESHOLDS: GovernanceThresholds = {
  toolDenialsPerHour: 20,
  sentinelBlocksPerHour: 15,
  outputLeaksPerHour: 5,
  outputLeaksPerAgentPerHour: 3,
};

export async function getGovernanceThresholds(): Promise<GovernanceThresholds> {
  const setting = await platformSettingsRepository.get('governance_thresholds');
  if (!setting) return DEFAULT_GOVERNANCE_THRESHOLDS;
  const value = setting.value as Partial<GovernanceThresholds>;
  return {
    toolDenialsPerHour: typeof value.toolDenialsPerHour === 'number' && value.toolDenialsPerHour > 0 ? value.toolDenialsPerHour : DEFAULT_GOVERNANCE_THRESHOLDS.toolDenialsPerHour,
    sentinelBlocksPerHour: typeof value.sentinelBlocksPerHour === 'number' && value.sentinelBlocksPerHour > 0 ? value.sentinelBlocksPerHour : DEFAULT_GOVERNANCE_THRESHOLDS.sentinelBlocksPerHour,
    outputLeaksPerAgentPerHour: typeof value.outputLeaksPerAgentPerHour === 'number' && value.outputLeaksPerAgentPerHour > 0 ? value.outputLeaksPerAgentPerHour : DEFAULT_GOVERNANCE_THRESHOLDS.outputLeaksPerAgentPerHour,
    outputLeaksPerHour: typeof value.outputLeaksPerHour === 'number' && value.outputLeaksPerHour > 0 ? value.outputLeaksPerHour : DEFAULT_GOVERNANCE_THRESHOLDS.outputLeaksPerHour,
  };
}

export async function setGovernanceThresholds(thresholds: GovernanceThresholds, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('governance_thresholds', thresholds, updatedByUserId);
}

/**
 * AURA AI Oversight & Reliability Agent: the tunable thresholds
 * oversightSweepService.ts evaluates every 15 minutes. Defaults are a
 * stated assumption to revisit once the sweep has run against real
 * production traffic - same honesty convention as GovernanceThresholds
 * above. authAbusePerHour/recaptchaFailuresPerHour are deliberately looser
 * than they might eventually need to be (30/20) since these two signals
 * were only wired into an audit trail this same session and have no real
 * production baseline yet; entitlementWarningPct/CriticalPct mirror the
 * two-tier "early signal vs firm concern" shape used elsewhere in this
 * codebase (e.g. biTrendService.ts's confidence tiers).
 */
export interface OversightThresholds {
  authAbusePerHour: number;
  recaptchaFailuresPerHour: number;
  aiUsageGrowthWarningPct: number;
  entitlementWarningPct: number;
  entitlementCriticalPct: number;
  connectionCeilingWarningPct: number;
  configDriftGraceHours: number;
}

const DEFAULT_OVERSIGHT_THRESHOLDS: OversightThresholds = {
  authAbusePerHour: 30,
  recaptchaFailuresPerHour: 20,
  aiUsageGrowthWarningPct: 50,
  entitlementWarningPct: 80,
  entitlementCriticalPct: 95,
  connectionCeilingWarningPct: 80,
  configDriftGraceHours: 24,
};

export async function getOversightThresholds(): Promise<OversightThresholds> {
  const setting = await platformSettingsRepository.get('oversight_thresholds');
  if (!setting) return DEFAULT_OVERSIGHT_THRESHOLDS;
  const value = setting.value as Partial<OversightThresholds>;
  const pick = (key: keyof OversightThresholds): number => (typeof value[key] === 'number' && (value[key] as number) > 0 ? (value[key] as number) : DEFAULT_OVERSIGHT_THRESHOLDS[key]);
  return {
    authAbusePerHour: pick('authAbusePerHour'),
    recaptchaFailuresPerHour: pick('recaptchaFailuresPerHour'),
    aiUsageGrowthWarningPct: pick('aiUsageGrowthWarningPct'),
    entitlementWarningPct: pick('entitlementWarningPct'),
    entitlementCriticalPct: pick('entitlementCriticalPct'),
    connectionCeilingWarningPct: pick('connectionCeilingWarningPct'),
    configDriftGraceHours: pick('configDriftGraceHours'),
  };
}

export async function setOversightThresholds(thresholds: OversightThresholds, updatedByUserId: string | null): Promise<void> {
  await platformSettingsRepository.set('oversight_thresholds', thresholds, updatedByUserId);
}
