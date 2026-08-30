import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { changePhoneNumber, PhoneNumberAlreadyInUseError } from '../src/services/phoneNumberChangeService.js';
import { register, InvalidCredentialsError } from '../src/services/authService.js';
import { registerTrial } from '../src/services/trialOnboardingService.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { requestBusinessDeletion, sweepDueAccountDeletions } from '../src/services/accountDeletionService.js';
import { resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const PASSWORD = 'correcthorsebatterystaple';

describe('phoneNumberChangeService.changePhoneNumber (real Postgres)', () => {
  it('rejects the wrong password without writing anything', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);

    await expect(
      changePhoneNumber(owner.business.id, owner.user.id, 'wrong-password', '+14155552671'),
    ).rejects.toThrow(InvalidCredentialsError);

    const { rows } = await pool.query<{ phone_number: string | null }>('SELECT phone_number FROM users WHERE id = $1', [owner.user.id]);
    expect(rows[0]?.phone_number).toBeNull();
  });

  it('updates both the encrypted phone number and its lookup hash on a correct password + valid number', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);

    await changePhoneNumber(owner.business.id, owner.user.id, PASSWORD, '+14155552671');

    const userRepository = new UserRepository(pool);
    const decrypted = await userRepository.getDecryptedPhoneNumber(owner.business.id, owner.user.id);
    expect(decrypted).toBe('+14155552671');

    const { rows } = await pool.query<{ phone_number_hash: string | null }>('SELECT phone_number_hash FROM users WHERE id = $1', [owner.user.id]);
    expect(rows[0]?.phone_number_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a number already claimed by a different active account', async () => {
    await resetDatabase();
    // register() first - it claims the single "default" business via
    // ensureDefaultBusinessProvisioned() while none exists yet.
    // registerTrial() always creates its own separate business directly,
    // so it's safe to call afterward without colliding with that default.
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);
    const trial = await registerTrial({ name: 'Existing', email: 'existing@example.com', phone: '+14155552671', productKey: 'property', device });

    await expect(
      changePhoneNumber(owner.business.id, owner.user.id, PASSWORD, '+14155552671'),
    ).rejects.toThrow(PhoneNumberAlreadyInUseError);
    void trial;
  });

  it('allows a number that was freed up by a deleted account', async () => {
    await resetDatabase();
    const trial = await registerTrial({ name: 'Old Owner', email: 'old-owner@example.com', phone: '+14155552671', productKey: 'property', device });
    await requestBusinessDeletion(trial.businessId, trial.user.id);
    await pool.query(`UPDATE businesses SET scheduled_purge_at = now() - interval '1 minute' WHERE id = $1`, [trial.businessId]);
    await sweepDueAccountDeletions();

    const owner = await register({ email: 'new-owner@example.com', password: PASSWORD, displayName: 'New Owner' }, device);

    // Proves this check is scoped to the live users.phone_number_hash
    // collision only, never the permanent trial_phone_fingerprints table -
    // a genuinely freed number must be assignable again.
    await expect(changePhoneNumber(owner.business.id, owner.user.id, PASSWORD, '+14155552671')).resolves.toBeUndefined();
  });
});
