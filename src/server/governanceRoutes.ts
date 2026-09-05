import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireDeveloper, type AuthContext } from './authMiddleware.js';
import { GovernanceFlagRepository } from '../repositories/governanceFlagRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { getGovernanceThresholds, setGovernanceThresholds } from '../services/platform/platformConfigService.js';

/**
 * AI Governance & Oversight (v1) - developer-only routes over the
 * governance_flags table. Every route here is unreachable from an AI
 * agent's own tool-calling path (agentGuard.ts / aiOrchestrator.ts never
 * imports this file) - a real structural guarantee that an agent cannot
 * review or dismiss its own governance flag, not just a policy promise.
 */

const router = Router();
const governanceFlagRepository = new GovernanceFlagRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

router.get('/developer/governance/flags', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json({ flags: await governanceFlagRepository.listOpenAcrossPlatform() });
});

const reviewActionSchema = z.object({ action: z.enum(['review', 'dismiss']) });

router.patch('/developer/governance/flags/:id', requireAuth, requireDeveloper, async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = reviewActionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_GOVERNANCE_ACTION', details: parsed.error.flatten() });

  const id = String(req.params.id ?? '');
  const flag = parsed.data.action === 'review'
    ? await governanceFlagRepository.markReviewed(id, auth.userId)
    : await governanceFlagRepository.markDismissed(id, auth.userId);
  if (!flag) return res.status(409).json({ error: 'FLAG_ALREADY_RESOLVED' });

  await securityAuditLogRepository
    .record({
      businessId: flag.businessId,
      eventType: parsed.data.action === 'review' ? 'governance_flag_reviewed' : 'governance_flag_dismissed',
      rawMetadata: { flagId: flag.id, flagType: flag.flagType, reviewedBy: auth.userId },
    })
    .catch((error) => console.error('[governanceRoutes] Failed to record flag lifecycle audit event:', error instanceof Error ? error.message : error));

  return res.status(200).json({ flag });
});

router.get('/developer/governance/thresholds', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json({ thresholds: await getGovernanceThresholds() });
});

const governanceThresholdsSchema = z.object({
  toolDenialsPerHour: z.number().int().min(1).max(10_000),
  sentinelBlocksPerHour: z.number().int().min(1).max(10_000),
  outputLeaksPerHour: z.number().int().min(1).max(10_000),
  outputLeaksPerAgentPerHour: z.number().int().min(1).max(10_000),
});

router.patch('/developer/governance/thresholds', requireAuth, requireDeveloper, async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = governanceThresholdsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_GOVERNANCE_THRESHOLDS', details: parsed.error.flatten() });
  await setGovernanceThresholds(parsed.data, auth.userId);
  return res.status(200).json({ thresholds: parsed.data });
});

export { router as governanceRouter };
