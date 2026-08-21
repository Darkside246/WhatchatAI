import { pool } from '../db/pool.js';
import { notifyBusiness } from './notificationService.js';
import type { SecurityEventType } from '../repositories/securityAuditLogRepository.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Read fresh on every scan run, not frozen at import time - same reasoning
// as agentGuard.ts's rate-limit config: an operator (or a test) changing
// the env should take effect without a process restart.
function getScanWindowHours(): number {
  return envInt('SECURITY_SCAN_WINDOW_HOURS', 24);
}
function getRenotifyCooldownHours(): number {
  return envInt('SECURITY_SCAN_RENOTIFY_COOLDOWN_HOURS', 24);
}

interface SecurityScanPattern {
  eventType: SecurityEventType;
  thresholdEnv: string;
  defaultThreshold: number;
  /** Stable, non-UUID key for this pattern - stored in notifications.target_type (TEXT), never target_id (UUID). */
  patternKey: string;
  title: string;
  body: (count: number, windowHours: number) => string;
}

/**
 * Deliberately just two real, already-logged, well-understood event
 * types to start - not a large speculative taxonomy. Both are denial
 * events that are already written to security_audit_logs on every real
 * occurrence (agentGuard.ts's guardToolInvocation, securityLockService.ts)
 * but, before this scan, were never surfaced to the business unless
 * someone happened to read the raw audit log.
 */
const PATTERNS: SecurityScanPattern[] = [
  {
    eventType: 'lock_unlock_failure',
    thresholdEnv: 'SECURITY_SCAN_LOCK_FAILURE_THRESHOLD',
    defaultThreshold: 5,
    patternKey: 'security_pattern:lock_unlock_failure',
    title: 'Repeated failed unlock attempts',
    body: (count, windowHours) =>
      `${count} failed screen-lock unlock attempts in the last ${windowHours}h. If this wasn't you, change your unlock passphrase.`,
  },
  {
    eventType: 'ai_tool_denied',
    thresholdEnv: 'SECURITY_SCAN_AI_TOOL_DENIED_THRESHOLD',
    defaultThreshold: 10,
    patternKey: 'security_pattern:ai_tool_denied',
    title: 'Repeated AI tool authorization denials',
    body: (count, windowHours) =>
      `${count} AI tool calls were denied by the Security Governor in the last ${windowHours}h - worth checking your agent configuration or recent conversations for anything unexpected.`,
  },
];

async function countRecentEventsByBusiness(eventType: SecurityEventType, windowHours: number): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ business_id: string; count: number }>(
    `SELECT business_id, count(*)::int AS count FROM security_audit_logs
     WHERE event_type = $1 AND created_at > now() - ($2 || ' hours')::interval
     GROUP BY business_id`,
    [eventType, windowHours],
  );
  return new Map(rows.map((row) => [row.business_id, Number(row.count)]));
}

/** Never re-alerts on a still-ongoing pattern more than once per cooldown - a real, recurring brute-force shouldn't spam a notification every scan run. */
async function alreadyNotifiedRecently(businessId: string, patternKey: string, cooldownHours: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
     WHERE business_id = $1 AND type = 'SECURITY_ALERT' AND target_type = $2
       AND created_at > now() - ($3 || ' hours')::interval
     LIMIT 1`,
    [businessId, patternKey, cooldownHours],
  );
  return rows.length > 0;
}

/**
 * Phase 18 of the original directive - a real, scheduled security scan,
 * never built until now. Deliberately reuses existing infrastructure
 * (security_audit_logs, notifications) rather than a new external
 * scanning service or a new database: every pattern here is a real,
 * already-written event, and this closes the gap between "logged" and
 * "the business actually sees it."
 */
export async function runSecurityScan(): Promise<void> {
  const windowHours = getScanWindowHours();
  const cooldownHours = getRenotifyCooldownHours();
  let alertsSent = 0;

  for (const pattern of PATTERNS) {
    const threshold = envInt(pattern.thresholdEnv, pattern.defaultThreshold);
    const counts = await countRecentEventsByBusiness(pattern.eventType, windowHours);

    for (const [businessId, count] of counts) {
      if (count < threshold) continue;
      if (await alreadyNotifiedRecently(businessId, pattern.patternKey, cooldownHours)) continue;

      await notifyBusiness({
        businessId,
        type: 'SECURITY_ALERT',
        severity: 'critical',
        title: pattern.title,
        body: pattern.body(count, windowHours),
        targetType: pattern.patternKey,
        targetId: null,
      }).catch((error) => {
        console.error(
          `[SecurityScanService] Failed to dispatch SECURITY_ALERT for business ${businessId}, pattern ${pattern.patternKey}:`,
          error,
        );
      });
      alertsSent += 1;
    }
  }

  if (alertsSent > 0) {
    console.log(`[SecurityScanService] Scan complete - ${alertsSent} new security alert(s) dispatched`);
  }
}
