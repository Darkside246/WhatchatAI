import { getSystemHealth } from '../systemHealthService.js';
import { sendEmailAlert, sendTelegramAlert, type AlertDispatchResult } from './alertChannels.js';

export interface IncidentCondition {
  key: 'database' | 'redis' | 'queues' | 'goose';
  message: string;
}

type SystemHealth = Awaited<ReturnType<typeof getSystemHealth>>;

function evaluateCriticalConditions(health: SystemHealth): IncidentCondition[] {
  const conditions: IncidentCondition[] = [];
  if (!health.database.available) {
    conditions.push({ key: 'database', message: `Database unavailable: ${health.database.error ?? 'unknown error'}` });
  }
  if (!health.redis.available) {
    conditions.push({ key: 'redis', message: `Redis unavailable: ${health.redis.error ?? 'unknown error'}` });
  }
  if (!health.queues.healthy) {
    const unhealthy = health.queues.queues.filter((queue) => !queue.healthy).map((queue) => queue.name);
    conditions.push({ key: 'queues', message: `Queue(s) unhealthy: ${unhealthy.join(', ')}` });
  }
  // A Goose that was never configured is expected (it's an optional AI
  // fallback), not an incident - only alert once it's configured but
  // actually unreachable.
  if (health.goose.configured && !health.goose.reachable) {
    conditions.push({ key: 'goose', message: `Goose fallback unreachable: ${health.goose.reason ?? 'unknown reason'}` });
  }
  return conditions;
}

function reminderIntervalMs(): number {
  const raw = Number(process.env.ALERT_REMINDER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
}

/**
 * In-memory, not DB-backed, deliberately: this monitors the database and
 * Redis themselves, so dedup state cannot depend on either being reachable
 * without risking silently never alerting on the exact failure it exists
 * to catch. The real cost is a duplicate "still down" alert right after an
 * app-server restart - a minor, acceptable tradeoff, not a correctness bug.
 */
let activeKeys = new Set<IncidentCondition['key']>();
let lastReminderSentAt = new Map<IncidentCondition['key'], number>();

export function __resetAlertStateForTests(): void {
  activeKeys = new Set();
  lastReminderSentAt = new Map();
}

export interface AlertDispatchers {
  email: (subject: string, bodyText: string) => Promise<AlertDispatchResult>;
  telegram: (message: string) => Promise<AlertDispatchResult>;
}

const defaultDispatchers: AlertDispatchers = { email: sendEmailAlert, telegram: sendTelegramAlert };

export interface CheckAndAlertResult {
  fired: IncidentCondition[];
  reminded: IncidentCondition[];
  recovered: IncidentCondition['key'][];
}

/**
 * Real incident detection over the same /api/health/* signals the
 * developer dashboard already shows (see systemHealthService.ts) - this
 * is the push side of that same pull-based data, not a separate source of
 * truth. Alerts only on a state transition (healthy -> unhealthy) plus a
 * periodic reminder while still unhealthy (default every 6h,
 * ALERT_REMINDER_INTERVAL_MS-overridable) - never on every single check,
 * and sends a real "recovered" notice once a condition clears.
 */
export async function checkAndAlert(
  healthFn: () => Promise<SystemHealth> = getSystemHealth,
  dispatchers: AlertDispatchers = defaultDispatchers,
  now: number = Date.now(),
): Promise<CheckAndAlertResult> {
  const health = await healthFn();
  const conditions = evaluateCriticalConditions(health);
  const currentKeys = new Set(conditions.map((condition) => condition.key));

  const fired: IncidentCondition[] = [];
  const reminded: IncidentCondition[] = [];
  for (const condition of conditions) {
    const wasActive = activeKeys.has(condition.key);
    if (!wasActive) {
      fired.push(condition);
      lastReminderSentAt.set(condition.key, now);
    } else {
      const lastReminder = lastReminderSentAt.get(condition.key) ?? 0;
      if (now - lastReminder >= reminderIntervalMs()) {
        reminded.push(condition);
        lastReminderSentAt.set(condition.key, now);
      }
    }
  }

  const recovered = [...activeKeys].filter((key) => !currentKeys.has(key));
  activeKeys = currentKeys;
  for (const key of recovered) lastReminderSentAt.delete(key);

  await Promise.all([
    ...fired.map((condition) => dispatchAlert(dispatchers, `INCIDENT: ${condition.message}`)),
    ...reminded.map((condition) => dispatchAlert(dispatchers, `STILL DOWN: ${condition.message}`)),
    ...recovered.map((key) => dispatchAlert(dispatchers, `RECOVERED: ${key} is healthy again`)),
  ]);

  return { fired, reminded, recovered };
}

async function dispatchAlert(dispatchers: AlertDispatchers, text: string): Promise<void> {
  const message = `[AURA] ${text}`;
  const [emailResult, telegramResult] = await Promise.all([
    dispatchers.email('AURA alert', message),
    dispatchers.telegram(message),
  ]);
  if (!emailResult.sent && !telegramResult.sent) {
    // Both channels either unconfigured or failed - the one place this
    // absolutely must not disappear silently, since it's already the
    // alerting path itself.
    console.error(`[IncidentAlertService] Could not deliver alert via any channel: ${message}`, {
      email: emailResult.reason,
      telegram: telegramResult.reason,
    });
  } else {
    console.log(`[IncidentAlertService] ${message}`);
  }
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

function checkIntervalMs(): number {
  const raw = Number(process.env.ALERT_CHECK_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

/** Started once from server/index.ts's boot sequence. Fire-and-forget, matching timeService.start()'s own pattern - a failed check just gets retried next interval. */
export function startIncidentMonitoring(): void {
  if (monitorTimer) return;
  if (process.env.ALERT_MONITORING_ENABLED === 'false') {
    console.log('[IncidentAlertService] Monitoring disabled (ALERT_MONITORING_ENABLED=false).');
    return;
  }
  monitorTimer = setInterval(() => {
    void checkAndAlert().catch((error) => {
      console.error('[IncidentAlertService] Health check itself failed:', error instanceof Error ? error.message : String(error));
    });
  }, checkIntervalMs());
  // Node keeps the process alive while an interval is scheduled by default;
  // unref lets a clean shutdown (SIGTERM) proceed without this timer alone
  // blocking process exit.
  monitorTimer.unref?.();
}

export function stopIncidentMonitoring(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
