import { pool } from '../db/pool.js';
import { SessionRepository } from '../repositories/sessionRepository.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { ProductAccountRepository } from '../repositories/productAccountRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { whatsappConnectionManager } from './whatsappConnectionManager.js';

const sessionRepository = new SessionRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);
const productAccountRepository = new ProductAccountRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

const DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export class BusinessDeletionAlreadyPendingError extends Error {}
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
  await whatsappConnectionManager.disconnect(businessId).catch((error: unknown) => {
    console.error(`[AccountDeletion] disconnect failed pre-purge for business ${businessId}:`, error);
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const owner = await client.query<{ user_id: string }>(
      `SELECT user_id FROM business_memberships WHERE business_id = $1 AND role = 'OWNER' LIMIT 1`,
      [businessId],
    );
    const ownerUserId = owner.rows[0]?.user_id ?? null;

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
