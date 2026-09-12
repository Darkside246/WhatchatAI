import { createHash, randomBytes, randomInt } from 'node:crypto';
import { pool } from '../db/pool.js';
import { UserRepository } from '../repositories/userRepository.js';
import { SessionRepository } from '../repositories/sessionRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { hashPassword, validatePasswordStrength } from './passwordHashService.js';
import { sendPlatformEmail, isPlatformMailerConfigured } from './platformMailer.js';

const userRepository = new UserRepository(pool);
const sessionRepository = new SessionRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class ResetTokenInvalidError extends Error {}
export class ResetRateLimitedError extends Error {}

/** How long a reset is good for. Long enough for a slow inbox, short enough that a forwarded email goes stale. */
const TOKEN_TTL_MINUTES = 30;
/**
 * Requests allowed per account per hour. Aimed at the nuisance case - a
 * stranger repeatedly triggering reset emails to someone's inbox - not at
 * guessing, which the token's own entropy already rules out.
 */
const MAX_REQUESTS_PER_HOUR = 5;

export type DeliveryChannel = 'email' | 'whatsapp';

/** Hashed the same way sessions are: the stored form must not be usable. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Asks for a password reset.
 *
 * ALWAYS REPORTS THE SAME THING, whether or not the address belongs to an
 * account. Saying "no account with that email" turns this endpoint into a
 * free membership oracle: anyone could test a list of addresses against it
 * and learn who uses AURA. The person who genuinely owns the address finds
 * out by receiving the mail.
 *
 * The one thing the caller does learn is which channel was used, because
 * the screen has to tell them where to look.
 */
export async function requestPasswordReset(email: string): Promise<{ channel: DeliveryChannel | null }> {
  const normalized = email.trim().toLowerCase();
  const user = await userRepository.findByEmail(normalized);
  if (!user || user.status !== 'active') return { channel: null };

  const recent = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM password_reset_tokens
     WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (Number(recent.rows[0]?.count ?? '0') >= MAX_REQUESTS_PER_HOUR) {
    throw new ResetRateLimitedError('Too many reset requests. Try again later.');
  }

  if (!isPlatformMailerConfigured()) {
    // No sender configured. Reported honestly rather than pretending a mail
    // was sent - see the route, which tells the person to contact support
    // instead of leaving them watching an inbox forever.
    return { channel: null };
  }

  // 32 bytes of CSPRNG. The token IS the credential, so its strength is the
  // whole of the security here - a short or guessable one would make every
  // account takeable by brute force against an endpoint that, by design,
  // cannot tell an attacker apart from a forgetful customer.
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, delivery_channel, expires_at)
     VALUES ($1, $2, 'email', now() + ($3 || ' minutes')::interval)`,
    [user.id, hashToken(token), TOKEN_TTL_MINUTES],
  );

  const link = `${resetBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const result = await sendPlatformEmail({
    toEmail: user.email,
    toName: user.displayName,
    subject: 'Reset your AURA password',
    bodyText:
      `Someone asked to reset the password for your AURA account.\n\n` +
      `Open this link within ${TOKEN_TTL_MINUTES} minutes to choose a new one:\n\n${link}\n\n` +
      `If that was not you, you can ignore this email - your password has not changed, ` +
      `and the link stops working on its own.\n`,
  });

  if (result.status === 'failed') {
    console.error('[passwordReset] Could not send the reset email:', result.reason);
    return { channel: null };
  }

  await securityAuditLogRepository
    .record({
      businessId: null,
      eventType: 'password_reset_requested',
      severity: 'warning',
      // Never the token, and never the address - this row is the fact that
      // a reset was asked for, which is what an investigation needs.
      rawMetadata: { userId: user.id, channel: 'email' },
    })
    .catch((error) => console.error('[passwordReset] Failed to record the request event:', error));

  return { channel: 'email' };
}

/**
 * Where the link points.
 *
 * Falls back to a relative path rather than baking in a wrong host that
 * would send people to somebody else's site - but a relative URL in an
 * EMAIL is not clickable, so that fallback means the reset link silently
 * does not work. Silently is the part worth fixing: an operator who has not
 * set APP_BASE_URL has no way to discover it except from a customer who
 * cannot get back into their account.
 *
 * So it is logged loudly, once per send, naming the variable and the
 * consequence. Still not thrown: a reset token HAS been issued by this
 * point, and refusing to send would leave the user with neither a working
 * link nor an explanation.
 */
function resetBaseUrl(): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured && configured.length > 0) return configured.replace(/\/+$/, '');

  console.error(
    '[passwordResetService] APP_BASE_URL is not set, so this reset link is relative and will not be clickable ' +
      'from an email client. Set APP_BASE_URL to the public origin of the app.',
  );
  return '';
}

/**
 * Spends a reset token and sets the new password.
 *
 * Every failure is the same error on purpose. Distinguishing "no such
 * token" from "expired" from "already used" tells someone holding a stale
 * link exactly how close they are, and tells an attacker which of their
 * guesses existed.
 */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
  validatePasswordStrength(newPassword);

  const { rows } = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  const record = rows[0];
  if (!record) throw new ResetTokenInvalidError('That reset link is invalid or has expired.');

  const credential = await hashPassword(newPassword);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Marked used inside the same transaction as the password write, and
    // guarded on still being unused, so two clicks on the same link cannot
    // both succeed - the second changes nothing.
    const spent = await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
      [record.id],
    );
    if (spent.rowCount === 0) throw new ResetTokenInvalidError('That reset link is invalid or has expired.');

    await client.query(
      `UPDATE users SET password_hash = $2, password_salt = $3, password_params = $4, updated_at = now() WHERE id = $1`,
      [record.user_id, credential.hash, credential.salt, JSON.stringify(credential.params)],
    );

    // Every other token for this account dies with it. Someone resetting a
    // password they think is compromised should not leave a second live
    // link sitting in an inbox an attacker may already be reading.
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [record.user_id],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // EVERY session, with no exception for a current one - unlike a signed-in
  // password change, the person doing this is not signed in, so any live
  // session belongs either to their old device or to whoever locked them
  // out. They sign in again with the password they just chose.
  const revoked = await sessionRepository.revokeAllForUserExcept(record.user_id, null);

  await securityAuditLogRepository
    .record({
      businessId: null,
      eventType: 'password_reset_completed',
      severity: 'critical',
      rawMetadata: { userId: record.user_id, sessionsRevoked: revoked },
    })
    .catch((error) => console.error('[passwordReset] Failed to record the completion event:', error));
}

/** Exported for the WhatsApp fallback, which sends a short code rather than a link. */
export function generateNumericCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
