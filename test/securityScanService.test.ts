import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { runSecurityScan } from '../src/services/securityScanService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const ENV_KEYS = [
  'SECURITY_SCAN_WINDOW_HOURS',
  'SECURITY_SCAN_RENOTIFY_COOLDOWN_HOURS',
  'SECURITY_SCAN_LOCK_FAILURE_THRESHOLD',
  'SECURITY_SCAN_AI_TOOL_DENIED_THRESHOLD',
];

/**
 * Phase 18 - a real, scheduled security scan (never built until now).
 * Both patterns scanned for are events already written on every real
 * denial elsewhere in the codebase (securityLockService.ts,
 * agentGuard.ts) - this reuses that existing audit trail rather than a
 * new logging path, and the property under test is purely "does a real
 * concerning pattern actually produce a real, visible notification, and
 * never more than once per cooldown."
 */
describe('runSecurityScan (real Postgres, real security_audit_logs -> real notifications)', () => {
  let businessId: string;
  let ownerId: string;
  const auditLog = new SecurityAuditLogRepository(pool);
  const notifications = new NotificationRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  async function recordFailures(eventType: 'lock_unlock_failure' | 'ai_tool_denied', count: number, forBusinessId = businessId) {
    for (let i = 0; i < count; i += 1) {
      await auditLog.record({ businessId: forBusinessId, eventType, severity: 'critical' });
    }
  }

  it('dispatches a real SECURITY_ALERT once a genuine pattern (repeated lock_unlock_failure) crosses its threshold', async () => {
    process.env.SECURITY_SCAN_LOCK_FAILURE_THRESHOLD = '3';
    await recordFailures('lock_unlock_failure', 3);

    await runSecurityScan();

    const list = await notifications.listForUser(businessId, ownerId, 10);
    const alert = list.find((n) => n.type === 'SECURITY_ALERT' && n.targetType === 'security_pattern:lock_unlock_failure');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('critical');
    expect(alert?.body).toContain('3 failed screen-lock unlock attempts');
  });

  it('dispatches a real SECURITY_ALERT once repeated ai_tool_denied crosses its own threshold', async () => {
    process.env.SECURITY_SCAN_AI_TOOL_DENIED_THRESHOLD = '2';
    await recordFailures('ai_tool_denied', 2);

    await runSecurityScan();

    const list = await notifications.listForUser(businessId, ownerId, 10);
    expect(list.some((n) => n.type === 'SECURITY_ALERT' && n.targetType === 'security_pattern:ai_tool_denied')).toBe(true);
  });

  it('never alerts when the count stays below the real threshold', async () => {
    process.env.SECURITY_SCAN_LOCK_FAILURE_THRESHOLD = '5';
    await recordFailures('lock_unlock_failure', 4);

    await runSecurityScan();

    const list = await notifications.listForUser(businessId, ownerId, 10);
    expect(list.some((n) => n.type === 'SECURITY_ALERT')).toBe(false);
  });

  it('never re-alerts on the same still-ongoing pattern within the cooldown window - one alert per real incident, not one per scan run', async () => {
    process.env.SECURITY_SCAN_LOCK_FAILURE_THRESHOLD = '3';
    process.env.SECURITY_SCAN_RENOTIFY_COOLDOWN_HOURS = '24';
    await recordFailures('lock_unlock_failure', 3);

    await runSecurityScan();
    await recordFailures('lock_unlock_failure', 2); // the pattern is still happening
    await runSecurityScan(); // a second scan run, same ongoing incident

    const list = await notifications.listForUser(businessId, ownerId, 10);
    const alerts = list.filter((n) => n.type === 'SECURITY_ALERT' && n.targetType === 'security_pattern:lock_unlock_failure');
    expect(alerts).toHaveLength(1);
  });

  it('re-alerts once the cooldown has genuinely elapsed', async () => {
    process.env.SECURITY_SCAN_LOCK_FAILURE_THRESHOLD = '3';
    process.env.SECURITY_SCAN_RENOTIFY_COOLDOWN_HOURS = '24';
    await recordFailures('lock_unlock_failure', 3);
    await runSecurityScan();

    // Simulate the cooldown having actually elapsed by backdating the real notification row.
    await pool.query(
      `UPDATE notifications SET created_at = now() - interval '25 hours' WHERE business_id = $1 AND type = 'SECURITY_ALERT'`,
      [businessId],
    );
    await recordFailures('lock_unlock_failure', 3);
    await runSecurityScan();

    const list = await notifications.listForUser(businessId, ownerId, 10);
    const alerts = list.filter((n) => n.type === 'SECURITY_ALERT' && n.targetType === 'security_pattern:lock_unlock_failure');
    expect(alerts).toHaveLength(2);
  });

  it('ignores events outside the real scan window - an old, resolved incident does not trigger a fresh alert', async () => {
    process.env.SECURITY_SCAN_LOCK_FAILURE_THRESHOLD = '3';
    process.env.SECURITY_SCAN_WINDOW_HOURS = '24';
    await recordFailures('lock_unlock_failure', 3);
    await pool.query(`UPDATE security_audit_logs SET created_at = now() - interval '48 hours' WHERE business_id = $1`, [businessId]);

    await runSecurityScan();

    const list = await notifications.listForUser(businessId, ownerId, 10);
    expect(list.some((n) => n.type === 'SECURITY_ALERT')).toBe(false);
  });

  it('never leaks an alert across tenants - a pattern in one business never notifies a different business', async () => {
    process.env.SECURITY_SCAN_LOCK_FAILURE_THRESHOLD = '3';
    const otherBusinessId = await createTestBusiness('Other Business');
    await recordFailures('lock_unlock_failure', 3, otherBusinessId);

    await runSecurityScan();

    const list = await notifications.listForUser(businessId, ownerId, 10);
    expect(list.some((n) => n.type === 'SECURITY_ALERT')).toBe(false);
  });
});
