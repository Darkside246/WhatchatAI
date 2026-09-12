import { pool } from '../db/pool.js';
import { UserRepository } from '../repositories/userRepository.js';
import { SessionRepository } from '../repositories/sessionRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from './passwordHashService.js';
import { InvalidCredentialsError } from './authService.js';

const userRepository = new UserRepository(pool);
const sessionRepository = new SessionRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class SamePasswordError extends Error {}

/**
 * Lets a signed-in person change their own password.
 *
 * WHAT THIS CLOSES. AURA had no way to change a password at all - no
 * endpoint, no screen, nothing in Settings. The only route was an operator
 * running scripts/resetPassword.js on the server, which meant every
 * password AURA ever set was permanent until someone with database access
 * changed it again. A password handed to a customer over WhatsApp stayed
 * their password forever.
 *
 * Confirmed with the CURRENT password, like changePhoneNumber beside it.
 * A signed-in session is not sufficient on its own: a borrowed laptop or a
 * stolen session token would otherwise be enough to lock the real owner out
 * of their own account permanently.
 */
export async function changePassword(
  businessId: string,
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentSessionId: string,
): Promise<{ otherSessionsRevoked: number }> {
  const user = await userRepository.findById(userId);
  if (!user) throw new InvalidCredentialsError('Account not found.');

  const valid = await verifyPassword(currentPassword, {
    hash: user.passwordHash,
    salt: user.passwordSalt,
    params: user.passwordParams,
  });
  if (!valid) throw new InvalidCredentialsError('Your current password is incorrect.');

  // Refused rather than silently accepted as a no-op: someone doing this
  // has a reason, and "saved" on a change that changed nothing would tell
  // them a problem was dealt with when it was not.
  if (currentPassword === newPassword) {
    throw new SamePasswordError('The new password is the same as the current one.');
  }

  // Enforced HERE, unlike the admin recovery script, which deliberately
  // skips it so it can rescue an account whose old credential predates the
  // current policy. This is a person choosing a new password, so the policy
  // applies in full.
  validatePasswordStrength(newPassword);

  const credential = await hashPassword(newPassword);
  await userRepository.updatePassword(userId, credential);

  /**
   * Every OTHER session is signed out, and this one is kept.
   *
   * Changing a password is what someone does when they think a credential
   * is compromised, and the new password alone evicts nobody - tokens
   * issued before this moment stay valid until they expire on their own. So
   * the change would look like it had secured the account without having
   * done so.
   *
   * The current session survives on purpose: signing people out of the
   * screen they are standing at, as a reward for improving their security,
   * teaches them not to do it again.
   */
  const otherSessionsRevoked = await sessionRepository.revokeAllForUserExcept(userId, currentSessionId);

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'password_changed',
    severity: 'info',
    // The fact and its blast radius, never the password or any part of it.
    rawMetadata: { userId, otherSessionsRevoked },
  });

  return { otherSessionsRevoked };
}
