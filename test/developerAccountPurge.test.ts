import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register, isInvalidCredentialsError } from '../src/services/authService.js';
import {
  deleteBusinessAsDeveloper,
  CannotDeleteOwnBusinessError,
  BusinessNotFoundError,
} from '../src/services/accountDeletionService.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { resetDatabase, createTestBusiness, createTestUser } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const DEV_PASSWORD = 'correcthorsebatterystaple';

/**
 * Erasing someone else's account, immediately, from the control plane.
 * Every assertion here is about something that cannot be undone, so the
 * refusals matter as much as the erasure.
 */
describe('deleteBusinessAsDeveloper (real Postgres, real cascade)', () => {
  let developerUserId: string;
  let developerBusinessId: string;
  let targetBusinessId: string;
  let targetUserId: string;

  beforeEach(async () => {
    await resetDatabase();
    const developer = await register({ email: 'dev@example.com', password: DEV_PASSWORD, displayName: 'Dev' }, device);
    developerUserId = developer.user.id;
    developerBusinessId = developer.business.id;

    // register() provisions the single default business and refuses a
    // second, so the account being deleted is built directly.
    targetBusinessId = await createTestBusiness('Customer Business');
    targetUserId = await createTestUser(targetBusinessId, 'customer@example.com');
  });

  it('erases the business and anonymises its owner', async () => {
    await deleteBusinessAsDeveloper(developerUserId, developerBusinessId, DEV_PASSWORD, targetBusinessId);

    const business = await pool.query('SELECT id FROM businesses WHERE id = $1', [targetBusinessId]);
    expect(business.rowCount).toBe(0);

    const user = await pool.query<{ email: string; phone_number: string | null; status: string; deleted_at: string | null }>(
      'SELECT email, phone_number, status, deleted_at FROM users WHERE id = $1',
      [targetUserId],
    );
    expect(user.rows[0]?.email).not.toBe('customer@example.com');
    expect(user.rows[0]?.phone_number).toBeNull();
    expect(user.rows[0]?.status).toBe('deactivated');
    expect(user.rows[0]?.deleted_at).not.toBeNull();
  });

  /**
   * These five tables carry a business_id but no foreign key to businesses
   * at all, so the cascade never reached them. They hold the owner's own
   * communication style, taken from things they personally wrote - exactly
   * what a deletion request is about - and it was surviving deletion
   * silently, in the self-service path as well as this one.
   */
  it('erases the writing-twin data the cascade cannot reach', async () => {
    await pool.query(
      `INSERT INTO writing_twin_settings (business_id, user_id, learning_enabled) VALUES ($1, $2, true)`,
      [targetBusinessId, targetUserId],
    );

    await deleteBusinessAsDeveloper(developerUserId, developerBusinessId, DEV_PASSWORD, targetBusinessId);

    const left = await pool.query('SELECT 1 FROM writing_twin_settings WHERE business_id = $1', [targetBusinessId]);
    expect(left.rowCount).toBe(0);
  });

  /**
   * Retention and erasure want different things: the figures, and the
   * person. Keeping the first does not require keeping the second.
   */
  it('keeps the accounting figures, without anything identifying', async () => {
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (business_id, manual_display_name) VALUES ($1, 'Mrs Greaves') RETURNING id`,
      [targetBusinessId],
    );
    await pool.query(
      `INSERT INTO invoices (business_id, contact_id, document_type, status, invoice_number, currency_code,
                             subtotal_cents, tax_basis_points, discount_cents, total_cents, issue_date)
       VALUES ($1, $2, 'INVOICE', 'SENT', 'INV-0007', 'BBD', 10000, 1750, 0, 11750, current_date)`,
      [targetBusinessId, contact.rows[0]!.id],
    );

    await deleteBusinessAsDeveloper(developerUserId, developerBusinessId, DEV_PASSWORD, targetBusinessId);

    const retained = await pool.query<{ document_reference: string; total_cents: string; tax_cents: string }>(
      `SELECT document_reference, total_cents, tax_cents FROM retained_financial_records
       WHERE business_id = $1 AND record_type = 'invoice'`,
      [targetBusinessId],
    );
    expect(retained.rows[0]?.document_reference).toBe('INV-0007');
    expect(Number(retained.rows[0]?.total_cents)).toBe(11750);
    expect(Number(retained.rows[0]?.tax_cents)).toBe(1750);

    // The customer went with the account. Only figures survive.
    const serialised = JSON.stringify(retained.rows);
    expect(serialised).not.toContain('Greaves');
    const contacts = await pool.query('SELECT 1 FROM crm_contacts WHERE business_id = $1', [targetBusinessId]);
    expect(contacts.rowCount).toBe(0);
  });

  /**
   * The audit row has to outlive the thing it records.
   * security_audit_logs.business_id cascades from businesses, so a row
   * scoped to the target would be deleted by the very operation it exists
   * to document.
   */
  it('leaves a platform-scoped audit trail that survives the purge', async () => {
    await deleteBusinessAsDeveloper(developerUserId, developerBusinessId, DEV_PASSWORD, targetBusinessId);

    const events = await new SecurityAuditLogRepository(pool).listPlatformEvents();
    const event = events.find((candidate) => candidate.eventType === 'business_purged_by_developer');
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).toContain(targetBusinessId);
  });

  describe('refuses', () => {
    it('a wrong password, leaving the account untouched', async () => {
      await expect(
        deleteBusinessAsDeveloper(developerUserId, developerBusinessId, 'not-my-password', targetBusinessId),
      ).rejects.toSatisfy(isInvalidCredentialsError);

      const business = await pool.query('SELECT id FROM businesses WHERE id = $1', [targetBusinessId]);
      expect(business.rowCount).toBe(1);
    });

    it("the caller's own business", async () => {
      // Almost certainly a mis-click on the wrong row - and if it is not,
      // the self-service path with its cancellable grace period is where
      // this belongs.
      await expect(
        deleteBusinessAsDeveloper(developerUserId, developerBusinessId, DEV_PASSWORD, developerBusinessId),
      ).rejects.toThrow(CannotDeleteOwnBusinessError);

      const business = await pool.query('SELECT id FROM businesses WHERE id = $1', [developerBusinessId]);
      expect(business.rowCount).toBe(1);
    });

    it('a business that does not exist', async () => {
      await expect(
        deleteBusinessAsDeveloper(developerUserId, developerBusinessId, DEV_PASSWORD, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(BusinessNotFoundError);
    });
  });
});
