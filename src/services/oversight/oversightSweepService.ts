/**
 * AURA AI Oversight & Reliability Agent - a broader, additional
 * supervisory layer alongside (not a replacement for) AI Governance v1's
 * own narrower AI-agent-behavior sweep (governanceSweepService.ts).
 *
 * Same non-negotiable structural guarantee as Governance v1, stated
 * plainly rather than left implicit: this file is invoked ONLY by its own
 * scheduled BullMQ job (incomingMessagesWorker.ts). Neither agentGuard.ts
 * nor aiOrchestrator.ts import anything from here, and there is no HTTP
 * route reachable from an AI agent's own tool-calling path into finding
 * creation, status-change, or threshold editing - every route in
 * oversightRoutes.ts requires requireDeveloper (a human session), and
 * this module itself exposes no route at all.
 *
 * Every rule below is 100% deterministic application code - real
 * threshold/rate/ratio comparisons against real, already-computed
 * numbers. No LLM call reads any of this data, so there is no
 * prompt-injection surface to defend in v1 at all, which is strictly
 * safer than defending one. Never fabricates a finding: a rule whose own
 * data source is unreachable reports its own monitoring degradation
 * (see runRule below) rather than silently reporting "all clear."
 */

import { pool, checkDatabaseHealth } from '../../db/pool.js';
import { checkRedisHealth } from '../../redis/client.js';
import { checkQueueHealth } from '../../queue/queueHealth.js';
import { getHealthSummary as getGooseHealthSummary } from '../gooseService.js';
import { whatsappConnectionManager } from '../whatsappConnectionManager.js';
import { OversightFindingRepository, type CreateOversightFindingInput } from '../../repositories/oversightFindingRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { AiUsageRepository } from '../../repositories/aiUsageRepository.js';
import { AiTokenTopupRepository } from '../../repositories/aiTokenTopupRepository.js';
import { PlatformSettingsRepository } from '../../repositories/platformSettingsRepository.js';
import { getOversightThresholds } from '../platform/platformConfigService.js';

const oversightFindingRepository = new OversightFindingRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const aiUsageRepository = new AiUsageRepository(pool);
const aiTokenTopupRepository = new AiTokenTopupRepository(pool);
const platformSettingsRepository = new PlatformSettingsRepository(pool);

/** Tighter than Governance's 30 min since this covers time-sensitive abuse/capacity signals too - a stated, tunable default. */
export const OVERSIGHT_SWEEP_INTERVAL_MS = 900_000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
/** How many samples oversight_metric_samples needs before a forecast is computed rather than reported as "insufficient historical data" - 8 samples at the 15-min sweep interval is 2 hours of real history. Stated, revisitable. */
const MIN_SAMPLES_FOR_FORECAST = 8;

/**
 * Creates a brand-new finding, or bumps an already-open one's
 * occurrence_count/last_detected_at - the "one continuing finding, not a
 * new emergency every sweep" rule (never spams a fresh row for a
 * still-triggering condition). Audits only on real, first creation.
 */
async function raiseOrBumpFinding(input: CreateOversightFindingInput): Promise<void> {
  const existing = await oversightFindingRepository.findOpenByDedupKey(input.dedupKey);
  if (existing) {
    await oversightFindingRepository.recordReoccurrence(existing.id);
    return;
  }
  const created = await oversightFindingRepository.create(input);
  await securityAuditLogRepository
    .record({
      businessId: input.businessId ?? null,
      eventType: 'oversight_finding_raised',
      severity: input.severity === 'critical' || input.severity === 'high' ? 'critical' : input.severity === 'medium' ? 'warning' : 'info',
      reason: input.title,
      rawMetadata: { findingId: created.id, findingType: input.findingType, category: input.category },
    })
    .catch(() => undefined);
}

/**
 * Self-monitoring (directive section 25): isolates one rule's own
 * failure from every other rule in the same sweep tick, and turns a
 * failure into a real, visible finding rather than a silent skip - the
 * agent must never falsely report "all clear" when it genuinely
 * couldn't check.
 */
async function runRule(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[oversightSweepService] Rule "${name}" failed:`, message);
    await securityAuditLogRepository
      .record({ businessId: null, eventType: 'oversight_monitoring_degraded', severity: 'warning', reason: `Rule "${name}" failed`, rawMetadata: { rule: name } })
      .catch(() => undefined);
    await raiseOrBumpFinding({
      category: 'monitoring_gap',
      findingType: 'monitoring_degraded',
      title: `Monitoring degraded: the "${name}" check could not run`,
      severity: 'medium',
      confidence: 1,
      evidence: { rule: name, error: message },
      recommendedInvestigation: `The "${name}" oversight rule's own data source is unreachable or erroring - investigate before trusting that this category is genuinely clear.`,
      dedupKey: `monitoring_degraded:${name}`,
    }).catch(() => undefined);
  }
}

// ── Application health ──────────────────────────────────────────────────

async function checkApplicationHealth(): Promise<void> {
  const [db, redis, queueSummary, goose] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkQueueHealth(),
    getGooseHealthSummary(),
  ]);

  if (!db.available) {
    await raiseOrBumpFinding({
      category: 'application_health',
      findingType: 'database_down',
      title: 'Database is unreachable',
      severity: 'critical',
      confidence: 1,
      impact: 5, likelihood: 5, exposure: 5, urgency: 5,
      evidence: { error: db.error, checkedAt: db.checkedAt },
      recommendedInvestigation: 'Check the Postgres service/container status and DATABASE_URL.',
      dedupKey: 'application_health:database_down',
    });
  }
  if (!redis.available) {
    await raiseOrBumpFinding({
      category: 'application_health',
      findingType: 'redis_down',
      title: 'Redis is unreachable',
      severity: 'critical',
      confidence: 1,
      impact: 5, likelihood: 5, exposure: 4, urgency: 5,
      evidence: { error: redis.error },
      recommendedInvestigation: 'Check the Redis service/container status - BullMQ queues (including this very sweep) cannot process without it.',
      dedupKey: 'application_health:redis_down',
    });
  }
  if (!queueSummary.healthy) {
    for (const queue of queueSummary.queues.filter((q) => !q.healthy)) {
      await raiseOrBumpFinding({
        category: 'application_health',
        findingType: 'queue_backlog_high',
        title: `Queue "${queue.name}" is unhealthy`,
        severity: queue.failed > 0 ? 'high' : 'medium',
        confidence: 1,
        impact: 3, likelihood: 4, exposure: 3, urgency: queue.failed > 0 ? 4 : 3,
        affectedComponent: queue.name,
        evidence: { queue: queue.name, waiting: queue.waiting, active: queue.active, failed: queue.failed, delayed: queue.delayed },
        recommendedInvestigation: `Queue "${queue.name}" has ${queue.waiting} waiting and ${queue.failed} failed jobs - check whether its worker is stalled or a job type is failing repeatedly.`,
        dedupKey: `application_health:queue_backlog:${queue.name}`,
      });
    }
  }
  if (goose.configured && !goose.reachable) {
    await raiseOrBumpFinding({
      category: 'application_health',
      findingType: 'goose_unreachable',
      title: 'Goose failover is configured but unreachable',
      severity: 'informational',
      confidence: 1,
      impact: 1, likelihood: 3, exposure: 2, urgency: 1,
      evidence: { reason: goose.reason ?? null, consecutiveFailureCount: goose.consecutiveFailureCount, lastFailureReason: goose.lastFailureReason },
      recommendedInvestigation: 'Goose is an optional fallback only - primary Gemini replies are unaffected, but failover would be unavailable if Gemini itself goes down.',
      dedupKey: 'application_health:goose_unreachable',
    });
  }
}

// ── Security / abuse ─────────────────────────────────────────────────────

async function checkAuthAbuse(): Promise<void> {
  const thresholds = await getOversightThresholds();
  const sinceIso = new Date(Date.now() - RATE_WINDOW_MS).toISOString();

  const authLimitedCount = await securityAuditLogRepository.countSince(['auth_rate_limited'], sinceIso);
  if (authLimitedCount >= thresholds.authAbusePerHour) {
    await raiseOrBumpFinding({
      category: 'abuse_spam',
      findingType: 'auth_abuse_spike',
      title: 'Repeated login/registration rate-limit trips',
      severity: authLimitedCount >= thresholds.authAbusePerHour * 3 ? 'high' : 'medium',
      confidence: 1,
      impact: 3, likelihood: 4, exposure: 4, urgency: 3,
      scopeDescription: 'Public auth/signup endpoints',
      evidence: { metric: 'auth_rate_limited count', windowHours: 1, count: authLimitedCount, threshold: thresholds.authAbusePerHour },
      recommendedInvestigation: 'Check /developer/security-events for the source IPs behind these trips - a sustained spike suggests credential stuffing or scripted signup abuse, not organic traffic.',
      windowStart: sinceIso, windowEnd: new Date().toISOString(),
      dedupKey: 'abuse_spam:auth_abuse_spike',
    });
  }

  const recaptchaFailedCount = await securityAuditLogRepository.countSince(['signup_recaptcha_failed'], sinceIso);
  if (recaptchaFailedCount >= thresholds.recaptchaFailuresPerHour) {
    await raiseOrBumpFinding({
      category: 'abuse_spam',
      findingType: 'recaptcha_failure_spike',
      title: 'Repeated signup reCAPTCHA failures',
      severity: recaptchaFailedCount >= thresholds.recaptchaFailuresPerHour * 3 ? 'high' : 'medium',
      confidence: 1,
      impact: 2, likelihood: 4, exposure: 3, urgency: 2,
      scopeDescription: 'Public trial-signup endpoint',
      evidence: { metric: 'signup_recaptcha_failed count', windowHours: 1, count: recaptchaFailedCount, threshold: thresholds.recaptchaFailuresPerHour },
      recommendedInvestigation: 'A sustained spike in failed verification suggests bot-driven signup attempts - if reCAPTCHA is not yet configured (RECAPTCHA_SECRET_KEY unset), every attempt currently passes through unverified.',
      windowStart: sinceIso, windowEnd: new Date().toISOString(),
      dedupKey: 'abuse_spam:recaptcha_failure_spike',
    });
  }
}

// ── Capacity ──────────────────────────────────────────────────────────────

async function checkAiUsageGrowth(): Promise<void> {
  const thresholds = await getOversightThresholds();
  const daily = await aiUsageRepository.getDailyPlatformTotals(14);
  if (daily.length < 8) return; // Fewer than 8 real days of data - never fabricate a week-over-week rate from a partial window.

  const last7 = daily.slice(-7).reduce((sum, d) => sum + d.totalTokens, 0);
  const prior7 = daily.slice(-14, -7).reduce((sum, d) => sum + d.totalTokens, 0);
  if (prior7 === 0) return; // No baseline to compare against yet - a real "emerging" case, not a rate.

  const growthPct = Math.round(((last7 - prior7) / prior7) * 1000) / 10;
  if (growthPct >= thresholds.aiUsageGrowthWarningPct) {
    await raiseOrBumpFinding({
      category: 'capacity',
      findingType: 'ai_usage_growth',
      title: `Platform AI token usage is up ${growthPct}% week-over-week`,
      severity: growthPct >= thresholds.aiUsageGrowthWarningPct * 2 ? 'medium' : 'low',
      confidence: 0.8,
      impact: 2, likelihood: 3, exposure: 2, urgency: 2,
      evidence: { last7DayTotal: last7, prior7DayTotal: prior7, growthPct, thresholdPct: thresholds.aiUsageGrowthWarningPct },
      recommendedInvestigation: 'Confirm this reflects real, wanted growth (more active tenants) rather than a runaway agent or inefficient prompt - check the Developer Control Plane\'s "top businesses by usage" view.',
      dedupKey: 'capacity:ai_usage_growth',
    });
  }
}

async function checkEntitlementProximity(): Promise<void> {
  const thresholds = await getOversightThresholds();
  const { rows: candidates } = await pool.query<{ business_id: string; business_name: string; limit_value: string }>(
    `SELECT b.id AS business_id, b.name AS business_name, pe.limit_value
     FROM businesses b
     JOIN subscriptions s ON s.business_id = b.id AND s.status IN ('ACTIVE', 'TRIALING')
     JOIN plan_entitlements pe ON pe.plan_id = s.plan_id AND pe.entitlement_key = 'max_ai_tokens_per_month' AND pe.is_enabled = true
     WHERE b.tier_unrestricted = false AND pe.limit_value IS NOT NULL`,
  );

  const nearLimit: Array<{ businessName: string; ratio: number }> = [];
  for (const candidate of candidates) {
    const planLimit = Number(candidate.limit_value);
    const [usage, topups] = await Promise.all([
      aiUsageRepository.getMonthlyTotalForBusiness(candidate.business_id),
      aiTokenTopupRepository.getVerifiedTokensThisMonthForBusiness(candidate.business_id),
    ]);
    const effectiveLimit = planLimit + topups;
    if (effectiveLimit <= 0) continue;
    const ratio = usage / effectiveLimit;
    if (ratio >= thresholds.entitlementWarningPct / 100) {
      nearLimit.push({ businessName: candidate.business_name, ratio: Math.round(ratio * 1000) / 10 });
    }
  }

  if (nearLimit.length > 0) {
    const anyCritical = nearLimit.some((b) => b.ratio >= thresholds.entitlementCriticalPct);
    await raiseOrBumpFinding({
      category: 'capacity',
      findingType: 'entitlement_near_limit',
      title: `${nearLimit.length} business${nearLimit.length === 1 ? '' : 'es'} within ${thresholds.entitlementWarningPct}% of their AI token limit`,
      severity: anyCritical ? 'medium' : 'low',
      confidence: 1,
      impact: 2, likelihood: 4, exposure: 2, urgency: anyCritical ? 3 : 2,
      evidence: { businesses: nearLimit, warningPct: thresholds.entitlementWarningPct, criticalPct: thresholds.entitlementCriticalPct },
      recommendedInvestigation: 'These businesses will hit their monthly AI reply limit soon (or already have) - the existing "Buy more tokens" top-up offer already covers this for the business owner; no action needed unless a pattern suggests a plan-tier mismatch.',
      dedupKey: 'capacity:entitlement_near_limit',
    });
  }
}

async function checkConnectionCeiling(): Promise<void> {
  const thresholds = await getOversightThresholds();
  const connected = whatsappConnectionManager.activeTenantCount();
  const ceiling = whatsappConnectionManager.maxConcurrentConnections();
  if (ceiling <= 0) return;
  const pct = Math.round((connected / ceiling) * 1000) / 10;
  if (pct >= thresholds.connectionCeilingWarningPct) {
    await raiseOrBumpFinding({
      category: 'capacity',
      findingType: 'connection_ceiling_near',
      title: `WhatsApp connections at ${pct}% of this process's configured ceiling`,
      severity: pct >= 95 ? 'high' : 'medium',
      confidence: 1,
      impact: 3, likelihood: 3, exposure: 3, urgency: pct >= 95 ? 4 : 2,
      evidence: { activeTenantCount: connected, ceiling, pct },
      recommendedInvestigation: 'Every tenant\'s Baileys connection lives in this one process (docs/DOCKER.md) - approaching WHATSAPP_MAX_CONCURRENT_CONNECTIONS means new tenants cannot connect until raised or the Droplet is resized.',
      dedupKey: 'capacity:connection_ceiling_near',
    });
  }
}

/** The only rule that also writes to oversight_metric_samples - the real, honest time-series for the two metrics with no existing historical persistence. */
async function sampleAndForecastCapacity(): Promise<void> {
  const queueSummary = await checkQueueHealth();
  const queueWaitingTotal = queueSummary.queues.reduce((sum, q) => sum + q.waiting, 0);
  const connectedTenants = whatsappConnectionManager.connectedTenantCount();

  await Promise.all([
    oversightFindingRepository.recordSample('queue_waiting_total', queueWaitingTotal),
    oversightFindingRepository.recordSample('whatsapp_connected_tenants', connectedTenants),
  ]);

  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const samples = await oversightFindingRepository.listRecentSamples('queue_waiting_total', sinceIso);
  if (samples.length < MIN_SAMPLES_FOR_FORECAST) return; // Real, stated honesty: not enough history yet for any projection.

  // A plain, real linear trend (least-squares slope over sample index) -
  // never an LLM-invented number. Only worth reporting when there's a
  // genuine, sustained upward slope approaching the existing queue-health
  // waiting-threshold (checkQueueHealth's own env-overridable default 500).
  const n = samples.length;
  const xs = samples.map((_, i) => i);
  const ys = samples.map((s) => s.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i]! - meanY), 0) / (xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0) || 1);
  const latest = ys[ys.length - 1] ?? 0;
  const queueWaitingCeiling = 500; // Matches checkQueueHealth's own QUEUE_HEALTH_WAITING_THRESHOLD default - a stated assumption if the operator has overridden that env var.

  if (slope > 0 && latest < queueWaitingCeiling) {
    const ticksToThreshold = (queueWaitingCeiling - latest) / slope;
    const hoursToThreshold = Math.round((ticksToThreshold * OVERSIGHT_SWEEP_INTERVAL_MS) / (60 * 60 * 1000));
    if (hoursToThreshold > 0 && hoursToThreshold <= 72) {
      await raiseOrBumpFinding({
        category: 'capacity',
        findingType: 'queue_backlog_trend',
        title: `Queue backlog trending upward - projected to reach the health threshold in ~${hoursToThreshold}h`,
        severity: hoursToThreshold <= 24 ? 'medium' : 'low',
        confidence: 0.6,
        impact: 3, likelihood: 3, exposure: 2, urgency: hoursToThreshold <= 24 ? 3 : 2,
        evidence: { currentWaitingTotal: latest, samplesUsed: n, slopePerSample: Math.round(slope * 100) / 100, projectedHoursToThreshold: hoursToThreshold },
        recommendedInvestigation: 'This is a real, computed linear projection from recent samples, not a guarantee - confirm via Developer Control Plane -> System Health before acting.',
        dedupKey: 'capacity:queue_backlog_trend',
      });
    }
  }
}

// ── Policy (runtime-observable config drift only - see plan's own note on why static source-parsing stays at CI time) ──

async function checkConfigDrift(): Promise<void> {
  const thresholds = await getOversightThresholds();
  const graceMs = thresholds.configDriftGraceHours * 60 * 60 * 1000;

  for (const key of ['maintenance_mode', 'registration_paused'] as const) {
    const setting = await platformSettingsRepository.get(key);
    if (!setting || setting.value !== true) continue;
    const ageMs = Date.now() - new Date(setting.updatedAt).getTime();
    if (ageMs >= graceMs) {
      await raiseOrBumpFinding({
        category: 'policy',
        findingType: 'config_left_on_too_long',
        title: `"${key}" has been enabled for longer than the expected grace period`,
        severity: key === 'maintenance_mode' ? 'high' : 'medium',
        confidence: 1,
        impact: key === 'maintenance_mode' ? 4 : 2, likelihood: 3, exposure: 3, urgency: 3,
        affectedComponent: key,
        evidence: { settingKey: key, enabledSince: setting.updatedAt, graceHours: thresholds.configDriftGraceHours, ageHours: Math.round(ageMs / (60 * 60 * 1000)) },
        recommendedInvestigation: `Confirm this is an intentional, ongoing state and not a toggle left on after a single incident was already resolved.`,
        dedupKey: `policy:config_left_on:${key}`,
      });
    }
  }
}

// ── Monitoring gaps (directive section 26 - always present, informational, honest) ──

async function reportMonitoringGaps(): Promise<void> {
  const gaps: Array<{ type: string; title: string; evidence: Record<string, unknown> }> = [
    {
      type: 'monitoring_gap_network_exposure',
      title: 'No network/port-exposure inspection exists',
      evidence: { note: 'Nothing in this application inspects open ports, listening services, or firewall state - this would need genuinely new infrastructure-level tooling, not something addressable from application code alone.' },
    },
    {
      type: 'monitoring_gap_tenant_memory',
      title: 'No per-tenant WhatsApp connection memory telemetry exists',
      evidence: { note: 'docs/DOCKER.md documents this as an unverified estimate ("tens of MB per connection") - real per-tenant memory measurement does not exist in-app today.' },
    },
    {
      type: 'monitoring_gap_latency',
      title: 'No per-endpoint latency/error-rate instrumentation exists',
      evidence: { note: 'No APM library (Sentry/DataDog/New Relic/OpenTelemetry/prom-client) is installed - getSystemHealth() reports availability only, never response time.' },
    },
    {
      type: 'monitoring_gap_openclaw',
      title: 'The OpenClaw security watcher is wired but dormant',
      evidence: { note: 'Zero OpenClaw cells are provisioned in production, so the existing 6-hourly openclaw-security-watcher job correctly no-ops every run - it is not currently a live security signal.' },
    },
  ];

  for (const gap of gaps) {
    await raiseOrBumpFinding({
      category: 'monitoring_gap',
      findingType: gap.type,
      title: gap.title,
      severity: 'informational',
      confidence: 1,
      impact: 2, likelihood: 1, exposure: 2, urgency: 1,
      evidence: gap.evidence,
      recommendedInvestigation: 'No action required unless this blind spot becomes a real priority - listed here so it is a known, honest gap rather than a silent one.',
      dedupKey: `monitoring_gap:${gap.type}`,
    });
  }
}

/** The scheduled entry point - one BullMQ job, no other caller, no HTTP route reaches this. */
export async function runOversightSweep(): Promise<void> {
  await runRule('application_health', checkApplicationHealth);
  await runRule('auth_abuse', checkAuthAbuse);
  await runRule('ai_usage_growth', checkAiUsageGrowth);
  await runRule('entitlement_proximity', checkEntitlementProximity);
  await runRule('connection_ceiling', checkConnectionCeiling);
  await runRule('capacity_forecast', sampleAndForecastCapacity);
  await runRule('config_drift', checkConfigDrift);
  await runRule('monitoring_gaps', reportMonitoringGaps);
}
