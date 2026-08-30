import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  requestBusinessDeletion,
  cancelBusinessDeletion,
  sweepDueAccountDeletions,
  BusinessDeletionAlreadyPendingError,
  BusinessDeletionNotPendingError,
} from '../src/services/accountDeletionService.js';
import { register, login, InvalidCredentialsError } from '../src/services/authService.js';
import { registerTrial, TrialPhoneAlreadyUsedOnboardingError } from '../src/services/trialOnboardingService.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const PASSWORD = 'correcthorsebatterystaple';

describe('accountDeletionService.requestBusinessDeletion / cancelBusinessDeletion (real Postgres)', () => {
  it('revokes every session and blocks login while a deletion is pending, then restores both on cancel', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);
    const businessId = owner.business.id;

    await requestBusinessDeletion(businessId, owner.user.id);

    // The session created by register() itself is gone.
    await expect(login('owner@example.com', PASSWORD, device)).rejects.toThrow(InvalidCredentialsError); // membership suspended -> no active membership

    await cancelBusinessDeletion(businessId);

    const relogin = await login('owner@example.com', PASSWORD, device);
    expect(relogin.token).toBeTruthy();
  });

  it('refuses a second deletion request while one is already pending', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);
    await requestBusinessDeletion(owner.business.id, owner.user.id);

    await expect(requestBusinessDeletion(owner.business.id, owner.user.id)).rejects.toThrow(BusinessDeletionAlreadyPendingError);
  });

  it('refuses to cancel when nothing is pending', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    await expect(cancelBusinessDeletion(businessId)).rejects.toThrow(BusinessDeletionNotPendingError);
  });

  it('stamps a scheduled purge date roughly 30 days out', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);
    const result = await requestBusinessDeletion(owner.business.id, owner.user.id);

    const scheduledMs = new Date(result.scheduledPurgeAt).getTime();
    const expectedMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(scheduledMs - expectedMs)).toBeLessThan(60_000); // within a minute of "now + 30 days"
  });
});

describe('accountDeletionService.sweepDueAccountDeletions (the real cascade-purge regression test)', () => {
  it('erases every row across the previously-non-cascading tables once scheduled_purge_at is due', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);
    const businessId = owner.business.id;

    const accountRepository = new WhatsAppAccountRepository(pool);
    const account = await accountRepository.upsertConnected({
      businessId,
      whatsappJid: '15550001111@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550001111',
      pushName: 'Test',
      connectionStatus: 'CONNECTED',
    });
    await createTestSubscription(businessId);
    await pool.query(
      `INSERT INTO security_audit_logs (business_id, event_type, severity, reason) VALUES ($1, 'sentinel_pass', 'info', 'fixture')`,
      [businessId],
    );

    await requestBusinessDeletion(businessId, owner.user.id);
    // Backdate as if the 30-day grace period already elapsed.
    await pool.query(`UPDATE businesses SET scheduled_purge_at = now() - interval '1 minute' WHERE id = $1`, [businessId]);

    await sweepDueAccountDeletions();

    const businessRow = await pool.query('SELECT id FROM businesses WHERE id = $1', [businessId]);
    expect(businessRow.rows).toHaveLength(0);

    const accountRow = await pool.query('SELECT id FROM whatsapp_accounts WHERE id = $1', [account.id]);
    expect(accountRow.rows).toHaveLength(0);

    const subscriptionRows = await pool.query('SELECT id FROM subscriptions WHERE business_id = $1', [businessId]);
    expect(subscriptionRows.rows).toHaveLength(0);

    const auditRows = await pool.query('SELECT id FROM security_audit_logs WHERE business_id = $1', [businessId]);
    expect(auditRows.rows).toHaveLength(0);

    const membershipRows = await pool.query('SELECT id FROM business_memberships WHERE business_id = $1', [businessId]);
    expect(membershipRows.rows).toHaveLength(0);
  });

  it('anonymizes the owner user row once they have zero remaining memberships anywhere', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);
    const businessId = owner.business.id;

    await requestBusinessDeletion(businessId, owner.user.id);
    await pool.query(`UPDATE businesses SET scheduled_purge_at = now() - interval '1 minute' WHERE id = $1`, [businessId]);
    await sweepDueAccountDeletions();

    const { rows } = await pool.query<{ email: string; display_name: string; phone_number: string | null; deleted_at: string | null; status: string }>(
      'SELECT email, display_name, phone_number, deleted_at, status FROM users WHERE id = $1',
      [owner.user.id],
    );
    expect(rows).toHaveLength(1); // anonymized, not hard-deleted
    expect(rows[0]?.email).toBe(`deleted-${owner.user.id}@deleted.invalid`);
    expect(rows[0]?.display_name).toBe('Deleted User');
    expect(rows[0]?.phone_number).toBeNull();
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(rows[0]?.status).toBe('deactivated');
  });

  it('never anonymizes a user who still belongs to another business', async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' }, device);
    const businessId = owner.business.id;
    const otherBusinessId = await createTestBusiness('Other Business');
    await pool.query(`INSERT INTO business_memberships (business_id, user_id, role) VALUES ($1, $2, 'OWNER')`, [otherBusinessId, owner.user.id]);

    await requestBusinessDeletion(businessId, owner.user.id);
    await pool.query(`UPDATE businesses SET scheduled_purge_at = now() - interval '1 minute' WHERE id = $1`, [businessId]);
    await sweepDueAccountDeletions();

    const { rows } = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [owner.user.id]);
    expect(rows[0]?.email).toBe('owner@example.com'); // untouched - still a real owner of otherBusinessId
  });

  it('the permanent phone fingerprint survives purge and still blocks a fresh trial signup on the same real number', async () => {
    await resetDatabase();
    const trial = await registerTrial({ name: 'Owner', email: 'owner@example.com', phone: '+14155552671', productKey: 'property', device });

    await requestBusinessDeletion(trial.businessId, trial.user.id);
    await pool.query(`UPDATE businesses SET scheduled_purge_at = now() - interval '1 minute' WHERE id = $1`, [trial.businessId]);
    await sweepDueAccountDeletions();

    const businessRow = await pool.query('SELECT id FROM businesses WHERE id = $1', [trial.businessId]);
    expect(businessRow.rows).toHaveLength(0); // genuinely gone

    await expect(
      registerTrial({ name: 'New Name', email: 'brand-new-email@example.com', phone: '+14155552671', productKey: 'property', device }),
    ).rejects.toThrow(TrialPhoneAlreadyUsedOnboardingError);
  });
});
