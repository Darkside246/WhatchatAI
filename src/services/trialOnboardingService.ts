import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { hashPassword, validatePasswordStrength } from './passwordHashService.js';
import { createAuthenticatedSession, type DeviceContext } from './authService.js';
import { normalizeTrialEmail, TRIAL_DURATION_MS, TRIAL_ABANDONMENT_WINDOW_MS } from './trialPolicy.js';
import { productEntitlements } from './productAccountService.js';
import type { ProductKey } from '../domain/platform/productAccounts.js';
import { UserRepository, toPublicUser } from '../repositories/userRepository.js';
import { normalizePhoneToE164, InvalidPhoneNumberError } from './phoneNormalizationService.js';
import { fingerprintPhoneNumber } from '../security/phoneFingerprint.js';
import { getEncryptionService } from '../security/encryption/index.js';

const users = new UserRepository(pool);

export class TrialAlreadyUsedOnboardingError extends Error {}
export class TrialPhoneAlreadyUsedOnboardingError extends Error {}
export class TrialProductUnavailableOnboardingError extends Error {}
export { InvalidPhoneNumberError };

/**
 * If `identityId`'s trial has never actually connected WhatsApp (per
 * whatsapp_connection_events) and the submitted phone matches what's on
 * file for it - proving this is the same person retrying after a failed
 * pairing, not merely someone who knows the email address - refreshes the
 * abandonment window and returns enough to resume the existing account.
 * Returns null (never throws) when resume isn't possible; the caller
 * decides what error to surface. Runs entirely inside the caller's own
 * transaction/client - never commits or rolls back itself.
 *
 * Security note: requiring the phone to match (not just the email) is
 * deliberate, not incidental. This resume path still never checks a
 * password (the account does have a real one now - see registerTrial's
 * own doc comment - it's simply not asked for here), so without the phone
 * check, anyone who merely knows an email address that recently started a
 * trial but hasn't paired yet could resubmit this form and receive a
 * fully authenticated session for that account - a real account-takeover
 * path this phone match is what actually closes.
 */
async function tryResumeTrial(
  client: PoolClient,
  identityId: string,
  phoneHash: string,
  productKey: ProductKey,
): Promise<{
  userId: string;
  businessId: string;
  productAccountId: string;
  productKey: ProductKey;
  trialId: string;
  startsAt: string;
  endsAt: string;
} | null> {
  const pending = await client.query<{
    business_id: string;
    user_id: string | null;
    product_account_id: string;
    product_key: ProductKey;
    trial_id: string;
    starts_at: string;
    ends_at: string;
    phone_number_hash: string | null;
  }>(
    `SELECT pa.business_id, ti.user_id, pt.product_account_id, pc.product_key,
            pt.id AS trial_id, pt.starts_at, pt.ends_at, u.phone_number_hash
       FROM trial_identities ti
       JOIN product_trials pt ON pt.trial_identity_id = ti.id
       JOIN product_accounts pa ON pa.id = pt.product_account_id
       JOIN product_catalog pc ON pc.id = pt.product_id
       LEFT JOIN users u ON u.id = ti.user_id
      WHERE ti.id = $1
      FOR UPDATE OF pa`,
    [identityId],
  );

  const row = pending.rows[0];
  if (!row || !row.user_id) return null;
  if (row.phone_number_hash !== phoneHash) return null;

  const connected = await client.query(
    `SELECT 1 FROM whatsapp_connection_events WHERE business_id = $1 AND event_type = 'connected' LIMIT 1`,
    [row.business_id],
  );
  if (connected.rows[0]) return null;

  if (productKey !== row.product_key) {
    console.warn(
      `[trialOnboardingService] Resume for identity ${identityId} requested product "${productKey}" but the ` +
        `original trial is for "${row.product_key}" - resuming into the original product, not switching.`,
    );
  }

  // Refreshed forward, not left at its original deadline - a resume near
  // the tail end of the original window must not still get purged
  // mid-retry by the next hourly sweep.
  await client.query(
    `UPDATE businesses SET scheduled_purge_at = $2, updated_at = now() WHERE id = $1`,
    [row.business_id, new Date(Date.now() + TRIAL_ABANDONMENT_WINDOW_MS).toISOString()],
  );

  return {
    userId: row.user_id,
    businessId: row.business_id,
    productAccountId: row.product_account_id,
    productKey: row.product_key,
    trialId: row.trial_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

/**
 * Landing-page onboarding transaction. It creates the client identity,
 * isolated product tenant, product entitlements and one 48-hour trial in one
 * database transaction. No payment information is collected.
 */
export async function registerTrial(input: {
  name: string;
  email: string;
  phone: string;
  password: string;
  productKey: ProductKey;
  device: DeviceContext;
}) {
  const name = input.name.trim();
  const email = normalizeTrialEmail(input.email);
  const phone = input.phone.trim();
  if (!name || !email || !phone) throw new Error('Name, email and phone are required.');

  // Real password, chosen by the person signing up - not the random,
  // never-shown placeholder this used to generate. Collected here (not
  // deferred to a later "secure your account" step) so a trial user can
  // log back in - via the normal password flow, not just the session
  // cookie from the moment they signed up - even before WhatsApp finishes
  // syncing; App.tsx's own gate already sends a logged-in-but-unconnected
  // user straight to the QR/link-code screen, so nothing else about the
  // resume path needs to change for that. Validated before the DB
  // transaction opens, same as the phone number below - fail fast, never
  // partway through a real transaction.
  validatePasswordStrength(input.password);

  // Normalized/hashed before the transaction even opens - an invalid
  // number should fail fast, never partway through a real DB transaction.
  const e164Phone = normalizePhoneToE164(phone);
  const phoneHash = fingerprintPhoneNumber(e164Phone);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{ id: string }>(`SELECT id FROM trial_identities WHERE email = $1 FOR UPDATE`, [email]);
    if (existing.rows[0]) {
      const resumed = await tryResumeTrial(client, existing.rows[0].id, phoneHash, input.productKey);
      if (!resumed) {
        // Either this identity's business already connected once (a
        // genuine repeat trial - the dedup table is doing exactly its
        // job), or the submitted phone doesn't match what's on file for
        // it. Both cases get the same generic message as before,
        // deliberately - a more specific "phone mismatch" error would let
        // an attacker who merely knows an email confirm whether a
        // pending, resumable trial exists for it.
        throw new TrialAlreadyUsedOnboardingError('This email has already received a trial.');
      }
      await client.query('COMMIT');

      const user = await users.findById(resumed.userId);
      if (!user) throw new Error('Trial user could not be reloaded');
      const session = await createAuthenticatedSession(resumed.userId, resumed.businessId, input.device, 'trial');

      return {
        user: toPublicUser(user),
        productAccountId: resumed.productAccountId,
        businessId: resumed.businessId,
        productKey: resumed.productKey,
        trialId: resumed.trialId,
        startsAt: resumed.startsAt,
        endsAt: resumed.endsAt,
        token: session.token,
        session: session.session,
      };
    }

    const phoneUsed = await client.query<{ id: string }>(`SELECT id FROM trial_phone_fingerprints WHERE phone_hash = $1 FOR UPDATE`, [phoneHash]);
    if (phoneUsed.rows[0]) throw new TrialPhoneAlreadyUsedOnboardingError('This phone number has already received a trial.');

    const product = await client.query<{ id: string; product_key: ProductKey; name: string }>(
      `SELECT id, product_key, name FROM product_catalog WHERE product_key = $1 AND is_active = true`, [input.productKey],
    );
    const productRow = product.rows[0];
    if (!productRow) throw new TrialProductUnavailableOnboardingError('The selected product is not available.');

    // Inserted before `users` (moved up from its original position after
    // the user insert) so a real businessId already exists to scope the
    // phone number's per-tenant encryption key below.
    //
    // scheduled_purge_at is stamped immediately - reusing
    // accountDeletionService.ts's existing scheduled-purge/sweep machinery
    // (sweepDueAccountDeletions -> purgeBusiness, already hourly, already
    // cascades correctly) rather than a new mechanism. A trial that never
    // gets a real WhatsApp connection is abandoned and eventually cleaned
    // up; whatsappTenantConnection.ts's persistConnectedAccount() clears
    // this the moment a real connection actually succeeds.
    const businessResult = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, scheduled_purge_at) VALUES ($1, $2) RETURNING id`,
      [`${name} - ${productRow.name}`, new Date(Date.now() + TRIAL_ABANDONMENT_WINDOW_MS).toISOString()],
    );
    const businessId = businessResult.rows[0]?.id;
    if (!businessId) throw new Error('Trial business creation returned no id');

    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + TRIAL_DURATION_MS);

    // Without a real subscriptions row, every entitlement-gated action
    // (connecting WhatsApp, creating an AI agent, launching a campaign -
    // see EntitlementService.checkEntitlement/checkCountLimit, both of
    // which require subscriptionRepository.findLiveByBusiness() to return
    // something) fails with "This business has no active subscription" for
    // every trial business, unconditionally - the product_entitlements rows
    // below are real, but nothing reads them without a live subscription to
    // resolve a plan through first. Same 'starter' plan and real-transaction
    // pattern businessBootstrapService.ts's single-tenant bootstrap already
    // uses, just scoped to this trial's own 48-hour window instead of that
    // flow's 14-day default.
    const plan = await client.query<{ id: string }>(`SELECT id FROM plans WHERE plan_key = 'starter'`);
    const planId = plan.rows[0]?.id;
    if (!planId) throw new Error('Seed plan "starter" not found - cannot provision a trial subscription. Did migrations run?');
    await client.query(
      `INSERT INTO subscriptions (business_id, plan_id, status, current_period_start, current_period_end, trial_ends_at)
       VALUES ($1, $2, 'TRIALING', $3, $4, $4)`,
      [businessId, planId, startsAt.toISOString(), endsAt.toISOString()],
    );

    const credential = await hashPassword(input.password);
    const phoneEnvelope = await getEncryptionService().encryptField(businessId, e164Phone);
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, password_salt, password_params, display_name, phone_number, phone_number_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [email, credential.hash, credential.salt, JSON.stringify(credential.params), name, getEncryptionService().serialize(phoneEnvelope), phoneHash],
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) throw new Error('Trial user creation returned no id');

    await client.query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);

    await client.query(
      `INSERT INTO business_memberships (business_id, user_id, role) VALUES ($1, $2, 'OWNER')`, [businessId, userId],
    );

    const accountResult = await client.query<{ id: string }>(
      `INSERT INTO product_accounts (business_id, product_id, owner_user_id, status, display_name)
       VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
      [businessId, productRow.id, userId, name],
    );
    const accountId = accountResult.rows[0]?.id;
    if (!accountId) throw new Error('Trial product account creation returned no id');

    for (const entitlementKey of productEntitlements[input.productKey]) {
      await client.query(
        `INSERT INTO product_entitlements (product_account_id, entitlement_key, is_enabled, source, expires_at)
         VALUES ($1, $2, true, 'TRIAL', $3)`, [accountId, entitlementKey, endsAt.toISOString()],
      );
    }

    const identityResult = await client.query<{ id: string }>(
      `INSERT INTO trial_identities (email, user_id) VALUES ($1, $2) RETURNING id`, [email, userId],
    );
    const identityId = identityResult.rows[0]?.id;
    if (!identityId) throw new Error('Trial identity creation returned no id');

    // Permanent, hash-only - survives this account being deleted later, so
    // the same real phone can't replay a fresh trial under a new email.
    await client.query(`INSERT INTO trial_phone_fingerprints (phone_hash) VALUES ($1) ON CONFLICT (phone_hash) DO NOTHING`, [phoneHash]);

    const trialResult = await client.query<{ id: string }>(
      `INSERT INTO product_trials (trial_identity_id, product_id, product_account_id, state, starts_at, ends_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5) RETURNING id`,
      [identityId, productRow.id, accountId, startsAt.toISOString(), endsAt.toISOString()],
    );
    const trialId = trialResult.rows[0]?.id;
    if (!trialId) throw new Error('Trial creation returned no id');

    await client.query(
      `INSERT INTO product_account_provisioning_events (product_account_id, event_type, metadata)
       VALUES ($1, 'CREATED', $2), ($1, 'PROVISIONED', $2)`,
      [accountId, JSON.stringify({ trialId, productKey: input.productKey })],
    );

    await client.query('COMMIT');

    const user = await users.findById(userId);
    if (!user) throw new Error('Trial user could not be reloaded');
    const session = await createAuthenticatedSession(userId, businessId, input.device, 'trial');

    return {
      user: toPublicUser(user),
      productAccountId: accountId,
      businessId,
      productKey: input.productKey,
      trialId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      token: session.token,
      session: session.session,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
