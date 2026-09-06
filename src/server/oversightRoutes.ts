import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireDeveloper, type AuthContext } from './authMiddleware.js';
import { OversightFindingRepository, type OversightCategory, type OversightSeverity, type OversightStatus } from '../repositories/oversightFindingRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { getOversightThresholds, setOversightThresholds } from '../services/platform/platformConfigService.js';

/**
 * AURA AI Oversight & Reliability Agent - developer-only routes over the
 * oversight_findings table. Every route here is unreachable from an AI
 * agent's own tool-calling path (agentGuard.ts / aiOrchestrator.ts never
 * imports this file), same structural guarantee as governanceRoutes.ts.
 */

const router = Router();
const oversightFindingRepository = new OversightFindingRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

const listQuerySchema = z.object({
  category: z.enum(['application_health', 'security', 'abuse_spam', 'capacity', 'policy', 'monitoring_gap']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'informational']).optional(),
});

router.get('/developer/oversight/findings', requireAuth, requireDeveloper, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  const filters: { category?: OversightCategory; severity?: OversightSeverity } = {};
  if (parsed.success && parsed.data.category) filters.category = parsed.data.category;
  if (parsed.success && parsed.data.severity) filters.severity = parsed.data.severity;
  return res.status(200).json({ findings: await oversightFindingRepository.listOpenAcrossPlatform(filters) });
});

router.get('/developer/oversight/findings/:id/events', requireAuth, requireDeveloper, async (req, res) => {
  const id = String(req.params.id ?? '');
  return res.status(200).json({ events: await oversightFindingRepository.listEventsForFinding(id) });
});

const changeStatusSchema = z.object({
  status: z.enum(['investigating', 'resolved', 'rejected', 'monitoring']),
  notes: z.string().trim().max(2000).nullish(),
});

router.patch('/developer/oversight/findings/:id', requireAuth, requireDeveloper, async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = changeStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_OVERSIGHT_ACTION', details: parsed.error.flatten() });

  const id = String(req.params.id ?? '');
  const status: OversightStatus = parsed.data.status;
  const finding = await oversightFindingRepository.changeStatus(id, status, auth.userId, parsed.data.notes ?? null);
  if (!finding) return res.status(409).json({ error: 'FINDING_ALREADY_RESOLVED' });

  await securityAuditLogRepository
    .record({
      businessId: finding.businessId,
      eventType: 'oversight_finding_status_changed',
      rawMetadata: { findingId: finding.id, findingType: finding.findingType, toStatus: status, changedBy: auth.userId },
    })
    .catch((error) => console.error('[oversightRoutes] Failed to record finding status-change audit event:', error instanceof Error ? error.message : error));

  return res.status(200).json({ finding });
});

router.get('/developer/oversight/thresholds', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json({ thresholds: await getOversightThresholds() });
});

const oversightThresholdsSchema = z.object({
  authAbusePerHour: z.number().int().min(1).max(100_000),
  recaptchaFailuresPerHour: z.number().int().min(1).max(100_000),
  aiUsageGrowthWarningPct: z.number().int().min(1).max(10_000),
  entitlementWarningPct: z.number().int().min(1).max(100),
  entitlementCriticalPct: z.number().int().min(1).max(100),
  connectionCeilingWarningPct: z.number().int().min(1).max(100),
  configDriftGraceHours: z.number().int().min(1).max(24 * 90),
});

router.patch('/developer/oversight/thresholds', requireAuth, requireDeveloper, async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = oversightThresholdsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_OVERSIGHT_THRESHOLDS', details: parsed.error.flatten() });
  await setOversightThresholds(parsed.data, auth.userId);
  return res.status(200).json({ thresholds: parsed.data });
});

export { router as oversightRouter };
