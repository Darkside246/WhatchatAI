import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { hashPassword } from './passwordHashService.js';
import { createAuthenticatedSession, type DeviceContext } from './authService.js';
import { normalizeTrialEmail, TRIAL_DURATION_MS } from './trialPolicy.js';
import { productEntitlements } from './productAccountService.js';
import type { ProductKey } from '../domain/platform/productAccounts.js';
import { UserRepository, toPublicUser } from '../repositories/userRepository.js';

const users = new UserRepository(pool);

export class TrialAlreadyUsedOnboardingError extends Error {}
export class TrialProductUnavailableOnboardingError extends Error {}

/**
 * Landing-page onboarding transaction. It creates the client identity,
 * isolated product tenant, product entitlements and one 48-hour trial in one
 * database transaction. No payment information is collected.
 */
export async function registerTrial(input: {
  name: string;
  email: string;
  phone: string;
  productKey: ProductKey;
  device: DeviceContext;
}) {
  const name = input.name.trim();
  const email = normalizeTrialEmail(input.email);
  const phone = input.phone.trim();
  if (!name || !email || !phone) throw new Error('Name, email and phone are required.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{ id: string }>(`SELECT id FROM trial_identities WHERE email = $1 FOR UPDATE`, [email]);
    if (existing.rows[0]) throw new TrialAlreadyUsedOnboardingError('This email has already received a trial.');

    const product = await client.query<{ id: string; product_key: ProductKey; name: string }>(
      `SELECT id, product_key, name FROM product_catalog WHERE product_key = $1 AND is_active = true`, [input.productKey],
    );
    const productRow = product.rows[0];
    if (!productRow) throw new TrialProductUnavailableOnboardingError('The selected product is not available.');

    const credential = await hashPassword(randomBytes(32).toString('base64url'));
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, password_salt, password_params, display_name, phone_number)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, credential.hash, credential.salt, JSON.stringify(credential.params), name, phone],
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) throw new Error('Trial user creation returned no id');

    await client.query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);

    const businessResult = await client.query<{ id: string }>(
      `INSERT INTO businesses (name) VALUES ($1) RETURNING id`, [`${name} - ${productRow.name}`],
    );
    const businessId = businessResult.rows[0]?.id;
    if (!businessId) throw new Error('Trial business creation returned no id');

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

    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + TRIAL_DURATION_MS);
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
