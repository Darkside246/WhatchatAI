import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { SessionRepository } from '../repositories/sessionRepository.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { ProductAccountRepository } from '../repositories/productAccountRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { verifyPassword } from './passwordHashService.js';
import { InvalidCredentialsError } from './authService.js';
import { whatsappConnectionManager } from './whatsappConnectionManager.js';

const sessionRepository = new SessionRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);
const productAccountRepository = new ProductAccountRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const userRepository = new UserRepository(pool);

const DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export class BusinessDeletionAlreadyPendingError extends Error {}
export class CannotDeleteOwnBusinessError extends Error {}
export class BusinessNotFoundError extends Error {}
export class BusinessDeletionNotPendingError extends Error {}

/**
 * Immediate effect of a real deletion request: stops the WhatsApp
 * connection, logs out every member, suspends the business's product
 * accounts, and stamps a 30-day purge deadline - but nothing is actually
 * erased yet (see sweepDueAccountDeletions for that). Mirrors
 * trialOnboardingService.ts's own raw-transaction shape.
 */
export async function requestBusinessDeletion(
  businessId: string,
  requestedByUserId: string,
): Promise<{ scheduledPurgeAt: string }> {
  // Disconnected first, outside the transaction - if this throws, no DB
  // state should have changed yet.
  await whatsappConnectionManager.disconnect(businessId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const scheduledPurgeAt = new Date(Date.now() + DELETION_GRACE_PERIOD_MS).toISOString();
    const updated = await client.query(
      `UPDATE businesses SET deletion_requested_at = now(), deletion_requested_by = $2, scheduled_purge_at = $3
       WHERE id = $1 AND deletion_requested_at IS NULL`,
      [businessId, requestedByUserId, scheduledPurgeAt],
    );
    if (updated.rowCount === 0) throw new BusinessDeletionAlreadyPendingError('A deletion request is already pending for this business.');

    await sessionRepository.revokeAllForBusiness(businessId);
    await membershipRepository.suspendAllForBusiness(businessId);

    const accounts = await productAccountRepository.listByBusiness(businessId);
    for (const account of accounts) {
      await productAccountRepository.setStatus(account.id, 'CLOSED');
      await productAccountRepository.recordProvisioningEvent(account.id, 'CLOSED');
    }

    await securityAuditLogRepository.record({
      businessId,
      eventType: 'account_deletion_requested',
      severity: 'warning',
      rawMetadata: { requestedByUserId, scheduledPurgeAt },
    });

    await client.query('COMMIT');
    return { scheduledPurgeAt };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reverses requestBusinessDeletion() within the 30-day grace window.
 * Sessions were already revoked when deletion was requested, so the
 * caller will need to log back in after this - expected, not a bug.
 */
export async function cancelBusinessDeletion(businessId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updated = await client.query(
      `UPDATE businesses SET deletion_requested_at = NULL, deletion_requested_by = NULL, scheduled_purge_at = NULL
       WHERE id = $1 AND deletion_requested_at IS NOT NULL`,
      [businessId],
    );
    if (updated.rowCount === 0) throw new BusinessDeletionNotPendingError('No deletion request is pending for this business.');

    await membershipRepository.reactivateAllForBusiness(businessId);

    const accounts = await productAccountRepository.listByBusiness(businessId);
    for (const account of accounts) {
      await productAccountRepository.setStatus(account.id, 'ACTIVE');
      await productAccountRepository.recordProvisioningEvent(account.id, 'REACTIVATED');
    }

    await securityAuditLogRepository.record({ businessId, eventType: 'account_deletion_cancelled', severity: 'info' });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Best-effort, outside the transaction - disconnect() never deleted the
  // real session credentials on disk, so a fresh connect() can resume
  // without a new QR. A failure here just leaves the business needing to
  // reconnect manually from Settings; it must never undo the cancellation
  // that already committed above.
  whatsappConnectionManager.connect(businessId).catch((error: unknown) => {
    console.error(`[AccountDeletion] Failed to resume WhatsApp for business ${businessId} after cancelling deletion:`, error);
  });
}

/** Called by the hourly account-deletion-purge-sweep job (see incomingMessagesWorker.ts). */
export async function sweepDueAccountDeletions(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM businesses WHERE scheduled_purge_at IS NOT NULL AND scheduled_purge_at <= now()`,
  );
  for (const { id: businessId } of rows) {
    await purgeBusiness(businessId);
  }
}

/**
 * Copies the accounting figures out before the cascade erases them.
 *
 * Tax authorities generally require invoice records to be kept for years,
 * whatever the customer has since asked for. That is not actually in
 * conflict with erasure, because the two want different things: retention
 * wants the FIGURES, erasure wants the PERSON gone. So the amounts, dates
 * and references are copied to retained_financial_records - with no name,
 * address, contact or line-item prose - and everything else is erased
 * exactly as before. See migration 1024 for why a snapshot rather than
 * exempting these tables from the cascade.
 *
 * ON CONFLICT DO NOTHING so a purge that failed midway and is retried by
 * the next sweep cannot duplicate the accounts.
 */
async function retainFinancialFigures(client: PoolClient, businessId: string): Promise<void> {
  await client.query(
    `INSERT INTO retained_financial_records
       (business_id, record_type, source_id, document_reference, currency_code, subtotal_cents, tax_cents, total_cents, status, issued_at, paid_at)
     SELECT business_id, 'invoice', id, invoice_number, currency_code, subtotal_cents,
            -- tax is stored as a basis-point rate, so the cash figure is
            -- derived here rather than left for a reader to recompute from
            -- a rate whose meaning may change.
            (subtotal_cents - discount_cents) * tax_basis_points / 10000,
            total_cents, status, issue_date::timestamptz, paid_at
     FROM invoices WHERE business_id = $1
     ON CONFLICT (record_type, source_id) DO NOTHING`,
    [businessId],
  );

  await client.query(
    `INSERT INTO retained_financial_records
       (business_id, record_type, source_id, status, issued_at)
     SELECT business_id, 'subscription', id, status, current_period_start
     FROM subscriptions WHERE business_id = $1
     ON CONFLICT (record_type, source_id) DO NOTHING`,
    [businessId],
  );

  for (const [table, type] of [
    ['ai_token_topup_purchases', 'token_topup'],
    ['ai_memory_topup_purchases', 'memory_topup'],
  ] as const) {
    await client.query(
      `INSERT INTO retained_financial_records
         (business_id, record_type, source_id, document_reference, currency_code, total_cents, status, issued_at, paid_at)
       SELECT business_id, $2, id, checkout_reference, currency, amount_minor, status, created_at, verified_at
       FROM ${table} WHERE business_id = $1
       ON CONFLICT (record_type, source_id) DO NOTHING`,
      [businessId, type],
    );
  }
}

/**
 * Deletes the tenant tables the cascade cannot reach.
 *
 * The five writing_twin_* tables carry a business_id but no foreign key to
 * businesses at all - not even a non-cascading one - so DELETE FROM
 * businesses left every one of them behind. They hold the owner's own
 * communication style: raw message events, extracted phrases, style
 * examples taken from things they personally wrote. That is exactly the
 * kind of data a deletion request is about, and it was surviving deletion
 * silently, in the self-service path as well as this one.
 *
 * Deleted explicitly here rather than by adding foreign keys, because that
 * is a schema change to five live tables for the sake of one code path, and
 * this call site can be read and verified in full. The tradeoff is the one
 * migration 939 warns about - an explicit list can fall behind the schema -
 * so anything added to writing_twin_* must be added here too.
 */
async function purgeUncascadedTables(client: PoolClient, businessId: string): Promise<void> {
  for (const table of [
    'writing_twin_raw_events',
    'writing_twin_style_examples',
    'writing_twin_agent_access',
    'writing_twin_profiles',
    'writing_twin_settings',
  ]) {
    await client.query(`DELETE FROM ${table} WHERE business_id = $1`, [businessId]);
  }
}

/**
 * The real, irreversible erasure. DELETE FROM businesses now cascades
 * across every tenant-scoped table (see migration 939) - the 28 tables
 * that used to block this were fixed specifically to make this call safe.
 * The owner's own users row is anonymized, not hard-deleted: hard-deleting
 * it risks an unaudited FK-restrict failure from a created_by/invited_by-
 * style column outside the businesses cascade tree, and anonymizing
 * already satisfies the real requirement (no recoverable PII) while
 * keeping the row id stable for any such reference.
 */
async function purgeBusiness(businessId: string): Promise<void> {
  // remove(), not disconnect() - this business's rows are about to be gone
  // for good, so its in-memory connection must be too (see remove()'s own
  // doc comment for the FK-violation bug leaving it behind caused).
  await whatsappConnectionManager.remove(businessId).catch((error: unknown) => {
    console.error(`[AccountDeletion] WhatsApp teardown failed pre-purge for business ${businessId}:`, error);
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const owner = await client.query<{ user_id: string }>(
      `SELECT user_id FROM business_memberships WHERE business_id = $1 AND role = 'OWNER' LIMIT 1`,
      [businessId],
    );
    const ownerUserId = owner.rows[0]?.user_id ?? null;

    await retainFinancialFigures(client, businessId);
    await purgeUncascadedTables(client, businessId);

    await client.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

    if (ownerUserId) {
      const remaining = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM business_memberships WHERE user_id = $1`,
        [ownerUserId],
      );
      if (Number(remaining.rows[0]?.count ?? '0') === 0) {
        await client.query(
          `UPDATE users SET
             email = 'deleted-' || id || '@deleted.invalid',
             display_name = 'Deleted User', first_name = NULL, last_name = NULL, avatar_url = NULL,
             phone_number = NULL, phone_number_hash = NULL,
             password_hash = 'deleted', password_salt = 'deleted', password_params = '{}'::jsonb,
             status = 'deactivated', deleted_at = now(), updated_at = now()
           WHERE id = $1`,
          [ownerUserId],
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[AccountDeletion] Purged business ${businessId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[AccountDeletion] Failed to purge business ${businessId}, will retry next sweep:`, error);
  } finally {
    client.release();
  }
}

/**
 * Erases one account immediately, on a developer's instruction.
 *
 * Different from requestBusinessDeletion above in two ways that matter.
 * That one is self-service, with a grace period the owner can cancel
 * within; this one is an operator acting on someone else's account and runs
 * straight away, because the reason to use it - fraud, abuse, a customer on
 * the phone asking now - does not wait out a countdown.
 *
 * CONFIRMED WITH THE DEVELOPER'S OWN PASSWORD. Being signed in as a
 * developer is not enough for a one-click, irreversible erasure of someone
 * else's business: an unlocked laptop, a forgotten open tab or a mis-click
 * on the wrong table row would each be sufficient otherwise.
 *
 * REFUSES THE CALLER'S OWN BUSINESS. Deleting the account you are signed in
 * to, from a console that only that account can reach, is almost certainly
 * a mis-click on the wrong row - and if it is not, the self-service path
 * with its cancellable grace period is the right way to do it.
 */
export async function deleteBusinessAsDeveloper(
  developerUserId: string,
  developerBusinessId: string,
  developerPassword: string,
  targetBusinessId: string,
): Promise<void> {
  if (targetBusinessId === developerBusinessId) {
    throw new CannotDeleteOwnBusinessError('Use the account settings page to delete your own business.');
  }

  const developer = await userRepository.findById(developerUserId);
  if (!developer) throw new InvalidCredentialsError('Account not found.');
  const valid = await verifyPassword(developerPassword, {
    hash: developer.passwordHash,
    salt: developer.passwordSalt,
    params: developer.passwordParams,
  });
  if (!valid) throw new InvalidCredentialsError('Your password is incorrect.');

  const target = await pool.query<{ id: string }>('SELECT id FROM businesses WHERE id = $1', [targetBusinessId]);
  if (!target.rows[0]) throw new BusinessNotFoundError('That business no longer exists.');

  // Recorded BEFORE the purge and as a PLATFORM event (business_id null).
  // security_audit_logs.business_id cascades from businesses, so an audit
  // row scoped to the target would be deleted by the very operation it
  // exists to record - leaving no trace that anyone did this.
  await securityAuditLogRepository.record({
    businessId: null,
    eventType: 'business_purged_by_developer',
    severity: 'critical',
    reason: 'A developer erased this account from the control plane.',
    rawMetadata: { targetBusinessId, developerUserId },
  });

  await purgeBusiness(targetBusinessId);
}
