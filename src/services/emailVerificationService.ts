import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { UserRepository } from '../repositories/userRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { sendPlatformEmail, isPlatformMailerConfigured } from './platformMailer.js';
import { renderWelcomeEmail } from './welcomeEmailTemplate.js';

const userRepository = new UserRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class VerificationTokenInvalidError extends Error {}
export class VerificationRateLimitedError extends Error {}

/** Long enough to survive a slow inbox and a night's sleep; short enough that a forwarded link goes stale. */
const TOKEN_TTL_HOURS = 48;
const MAX_SENDS_PER_HOUR = 5;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function baseUrl(): string {
  const configured = process.env.APP_BASE_URL?.trim();
  return configured && configured.length > 0 ? configured.replace(/\/+$/, '') : '';
}

/**
 * Sends the welcome email, which is also the verification email.
 *
 * ONE EMAIL, NOT TWO, on purpose. A welcome that asks nothing gets skimmed
 * and deleted; a bare "verify your address" with no context looks like
 * phishing. Together, the thing the person wants to read carries the thing
 * we need them to do.
 *
 * WHAT IS AND IS NOT IN THE LINK. Their name appears in the BODY - it is
 * their own inbox, and a welcome that cannot say hello is not a welcome.
 * The LINK is 32 random bytes and nothing else: no name, no address, no
 * user id, nothing encoded or derivable. Anyone who intercepts it learns
 * that somebody signed up, and nothing about who.
 *
 * Never throws. Signup has already succeeded by the time this runs, and a
 * mail provider having a bad minute must not undo an account someone has
 * just created - they can ask for the email again.
 */
export async function sendWelcomeVerificationEmail(userId: string): Promise<{ sent: boolean; reason?: string }> {
  try {
    const user = await userRepository.findById(userId);
    if (!user) return { sent: false, reason: 'No such user.' };
    if (user.emailVerifiedAt) return { sent: false, reason: 'Already verified.' };
    if (!isPlatformMailerConfigured()) return { sent: false, reason: 'No platform email sender is configured.' };

    const recent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM email_verification_tokens
       WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
      [userId],
    );
    if (Number(recent.rows[0]?.count ?? '0') >= MAX_SENDS_PER_HOUR) {
      throw new VerificationRateLimitedError('Too many verification emails requested. Try again later.');
    }

    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
      [userId, hashToken(token), TOKEN_TTL_HOURS],
    );

    const rendered = await renderWelcomeEmail({
      displayName: user.displayName,
      verifyUrl: `${baseUrl()}/verify-email?token=${encodeURIComponent(token)}`,
      expiresInHours: TOKEN_TTL_HOURS,
    });

    const result = await sendPlatformEmail({
      toEmail: user.email,
      toName: user.displayName,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
    });

    if (result.status === 'failed') {
      console.error('[emailVerification] Could not send the welcome email:', result.reason);
      return { sent: false, reason: result.reason };
    }

    await securityAuditLogRepository
      .record({
        businessId: null,
        eventType: 'email_verification_sent',
        severity: 'info',
        rawMetadata: { userId },
      })
      .catch((error) => console.error('[emailVerification] Failed to record the send event:', error));

    return { sent: true };
  } catch (error) {
    if (error instanceof VerificationRateLimitedError) throw error;
    console.error('[emailVerification] Welcome email failed:', error instanceof Error ? error.message : error);
    return { sent: false, reason: 'The welcome email could not be sent.' };
  }
}

/**
 * Spends a verification token and marks the address confirmed.
 *
 * One indistinguishable error for every failure, as with password reset:
 * separating "expired" from "already used" from "never existed" tells
 * somebody holding a stale link how close they are.
 */
export async function verifyEmailWithToken(token: string): Promise<void> {
  const { rows } = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM email_verification_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  const record = rows[0];
  if (!record) throw new VerificationTokenInvalidError('That verification link is invalid or has expired.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Guarded on still being unused, in the same transaction as the write
    // it authorises, so a double-click cannot spend it twice.
    const spent = await client.query(
      `UPDATE email_verification_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
      [record.id],
    );
    if (spent.rowCount === 0) throw new VerificationTokenInvalidError('That verification link is invalid or has expired.');

    // COALESCE keeps the FIRST verification time. Re-verifying later should
    // not rewrite the date the address was actually proved.
    await client.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`,
      [record.user_id],
    );

    // Any other outstanding link for this account is now pointless, and a
    // live link in an old inbox is a liability rather than a convenience.
    await client.query(
      `UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [record.user_id],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await securityAuditLogRepository
    .record({
      businessId: null,
      eventType: 'email_verified',
      severity: 'info',
      rawMetadata: { userId: record.user_id },
    })
    .catch((error) => console.error('[emailVerification] Failed to record the verification event:', error));
}
