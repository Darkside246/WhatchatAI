import { sendEmailAlert, sendTelegramAlert, type AlertDispatchResult } from './alertChannels.js';

/**
 * Getting a security finding in front of a person.
 *
 * Found in a security review: the oversight sweep genuinely detects auth
 * abuse, screening failures and the rest, and writes each one to
 * oversight_findings with an audit row beside it - and then stops. Nothing
 * was dispatched anywhere. Meanwhile incidentAlertService had a fully built
 * email-and-Telegram path that only database, Redis, queue and Goose health
 * ever used.
 *
 * So a credential-stuffing run against the login endpoint raised a real,
 * correct, severity-high finding that sat in a table until somebody thought
 * to open the developer console and look. Detection that reaches nobody is a
 * log, not a control.
 *
 * This is the missing wire and nothing more: the same two channels, the same
 * "never pretend an alert was sent" honesty, deliberately in its own module
 * so the security path never depends on incident monitoring being enabled
 * (ALERT_MONITORING_ENABLED=false turns off health polling, and must not
 * also silence security).
 */

export interface AlertDispatchers {
  email: (subject: string, bodyText: string) => Promise<AlertDispatchResult>;
  telegram: (message: string) => Promise<AlertDispatchResult>;
}

const defaultDispatchers: AlertDispatchers = { email: sendEmailAlert, telegram: sendTelegramAlert };

export interface SecurityAlert {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  title: string;
  /** What a person should actually go and do. Never a bare metric. */
  detail: string;
}

/**
 * Which findings are worth waking somebody for.
 *
 * Only critical and high. A medium finding is a real thing to look at during
 * the day and a bad thing to be paged about at 3am - and an alert channel
 * that cries wolf is one people mute, which is strictly worse than having
 * none. Everything, at every severity, is still written to
 * oversight_findings and the security audit log regardless; this decides
 * only what gets pushed.
 */
export function shouldDispatch(severity: SecurityAlert['severity']): boolean {
  return severity === 'critical' || severity === 'high';
}

/**
 * Sends one security alert on every configured channel.
 *
 * Never throws. This is called from inside a sweep that must keep running -
 * an unreachable mail provider is not a reason to abandon the rest of the
 * checks, and the caller has already persisted the finding by the time this
 * runs, so a failure here loses a notification, never a record.
 *
 * Returns whether it actually reached anywhere, so a caller (and a test) can
 * tell "delivered" from "no channel is configured on this deployment".
 */
export async function dispatchSecurityAlert(
  alert: SecurityAlert,
  dispatchers: AlertDispatchers = defaultDispatchers,
): Promise<{ delivered: boolean }> {
  const message = `[AURA SECURITY] ${alert.severity.toUpperCase()}: ${alert.title}\n\n${alert.detail}`;

  const [email, telegram] = await Promise.all([
    dispatchers.email(`AURA security alert: ${alert.title}`, message).catch(
      (error: unknown): AlertDispatchResult => ({ sent: false, reason: error instanceof Error ? error.message : String(error) }),
    ),
    dispatchers.telegram(message).catch(
      (error: unknown): AlertDispatchResult => ({ sent: false, reason: error instanceof Error ? error.message : String(error) }),
    ),
  ]);

  const delivered = email.sent || telegram.sent;
  if (!delivered) {
    /* The one place this must never disappear quietly: it is the alerting
       path itself failing, so the log line is the last thing left. */
    console.error(`[SecurityAlert] Could not deliver via any channel: ${message}`, {
      email: email.reason,
      telegram: telegram.reason,
    });
  } else {
    console.warn(`[SecurityAlert] ${alert.severity}: ${alert.title}`);
  }
  return { delivered };
}
