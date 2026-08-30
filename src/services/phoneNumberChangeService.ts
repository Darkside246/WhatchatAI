import { pool } from '../db/pool.js';
import { UserRepository } from '../repositories/userRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { verifyPassword } from './passwordHashService.js';
import { InvalidCredentialsError } from './authService.js';
import { normalizePhoneToE164 } from './phoneNormalizationService.js';
import { fingerprintPhoneNumber } from '../security/phoneFingerprint.js';

const userRepository = new UserRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class PhoneNumberAlreadyInUseError extends Error {}

/**
 * Password-confirmed edit, no SMS/OTP verification (no SMS provider exists
 * in this codebase - a deliberately deferred future upgrade, not part of
 * this feature). Deliberately never touches trial_phone_fingerprints -
 * that table is scoped to signup-time trial-abuse dedup only; a real
 * account can change its contact number freely, constrained only by not
 * colliding with another currently-active account's number.
 */
export async function changePhoneNumber(
  businessId: string,
  userId: string,
  password: string,
  newRawPhone: string,
): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user) throw new InvalidCredentialsError('Account not found.');

  const valid = await verifyPassword(password, { hash: user.passwordHash, salt: user.passwordSalt, params: user.passwordParams });
  if (!valid) throw new InvalidCredentialsError('Incorrect password.');

  const e164Phone = normalizePhoneToE164(newRawPhone);
  const phoneHash = fingerprintPhoneNumber(e164Phone);

  const collision = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE phone_number_hash = $1 AND id != $2 AND deleted_at IS NULL`,
    [phoneHash, userId],
  );
  if (collision.rows[0]) throw new PhoneNumberAlreadyInUseError('This phone number is already in use by another account.');

  await userRepository.updatePhoneNumber(businessId, userId, e164Phone, phoneHash);
  await securityAuditLogRepository.record({ businessId, eventType: 'phone_number_changed', severity: 'info' });
}
