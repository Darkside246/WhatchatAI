import { pool } from '../db/pool.js';
import { ProductAccountRepository } from '../repositories/productAccountRepository.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { TrialRepository } from '../repositories/trialRepository.js';
import { deriveTrialState } from './trialPolicy.js';
import type { ProductKey, ProductAccountAccess } from '../domain/platform/productAccounts.js';

const productAccounts = new ProductAccountRepository(pool);
const memberships = new BusinessMembershipRepository(pool);
const trials = new TrialRepository(pool);

const PRODUCT_ENTITLEMENTS: Record<ProductKey, string[]> = {
  property:     ['property.dashboard', 'property.conversations', 'property.maintenance', 'property.work_orders', 'property.properties', 'property.vendors', 'property.reports'],
  food:         ['food.dashboard', 'food.conversations', 'food.orders', 'food.menu', 'food.kitchen', 'food.pickup_delivery', 'food.customers', 'food.reports'],
  commerce:     ['commerce.dashboard', 'commerce.quotes', 'commerce.invoices', 'commerce.inventory', 'commerce.customers'],
  scheduling:   ['scheduling.dashboard', 'scheduling.appointments', 'scheduling.availability'],
  support:      ['support.dashboard', 'support.conversations', 'support.handoff', 'support.reports'],
  retail:       ['retail.dashboard', 'retail.conversations', 'retail.orders', 'retail.inventory', 'retail.customers', 'retail.marketing'],
  beauty:       ['beauty.dashboard', 'beauty.conversations', 'beauty.bookings', 'beauty.services', 'beauty.clients', 'beauty.marketing'],
  auto:         ['auto.dashboard', 'auto.conversations', 'auto.jobs', 'auto.vehicles', 'auto.quotes', 'auto.customers', 'auto.marketing'],
  health:       ['health.dashboard', 'health.conversations', 'health.appointments', 'health.patients', 'health.records', 'health.communications'],
  legal:        ['legal.dashboard', 'legal.conversations', 'legal.cases', 'legal.documents', 'legal.clients', 'legal.consultations'],
  hospitality:  ['hospitality.dashboard', 'hospitality.conversations', 'hospitality.bookings', 'hospitality.rooms', 'hospitality.guests', 'hospitality.housekeeping'],
  construction: ['construction.dashboard', 'construction.conversations', 'construction.projects', 'construction.subcontractors', 'construction.materials', 'construction.clients'],
  logistics:    ['logistics.dashboard', 'logistics.conversations', 'logistics.deliveries', 'logistics.routes', 'logistics.drivers', 'logistics.customers'],
};

export class ProductAccountAlreadyExistsError extends Error {}
export class ProductNotFoundError extends Error {}
export class ProductAccountNotFoundError extends Error {}

export async function listAvailableProducts() {
  return productAccounts.listProducts();
}

export async function listUserProductAccounts(userId: string): Promise<ProductAccountAccess[]> {
  const accounts = await productAccounts.listForOwner(userId);
  return Promise.all(accounts.map((account) => getAccountAccessForMember(userId, account.id)));
}

export async function listAllProductAccounts() {
  return productAccounts.listAll();
}

/** Provisions a focused product tenant. Each product gets its own business and data boundary. */
export async function provisionProductAccount(input: {
  ownerUserId: string;
  productKey: ProductKey;
  displayName: string;
}): Promise<ProductAccountAccess> {
  const existing = await productAccounts.findForOwnerAndProduct(input.ownerUserId, input.productKey);
  if (existing) throw new ProductAccountAlreadyExistsError('This user already owns this product.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query<{ id: string; product_key: ProductKey }>(
      `SELECT id, product_key FROM product_catalog WHERE product_key = $1 AND is_active = true`, [input.productKey],
    );
    const productRow = product.rows[0];
    if (!productRow) throw new ProductNotFoundError('Product is not available.');

    const businessResult = await client.query<{ id: string }>(
      `INSERT INTO businesses (name) VALUES ($1) RETURNING id`, [input.displayName.trim()],
    );
    const businessId = businessResult.rows[0]?.id;
    if (!businessId) throw new Error('Business provisioning returned no id');

    await client.query(
      `INSERT INTO business_memberships (business_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
      [businessId, input.ownerUserId],
    );
    const accountResult = await client.query<{ id: string }>(
      `INSERT INTO product_accounts (business_id, product_id, owner_user_id, status, display_name)
       VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
      [businessId, productRow.id, input.ownerUserId, input.displayName.trim()],
    );
    const accountId = accountResult.rows[0]?.id;
    if (!accountId) throw new Error('Product account provisioning returned no id');

    for (const key of PRODUCT_ENTITLEMENTS[input.productKey]) {
      await client.query(
        `INSERT INTO product_entitlements (product_account_id, entitlement_key, is_enabled, source)
         VALUES ($1, $2, true, 'PRODUCT')`, [accountId, key],
      );
    }
    await client.query(
      `INSERT INTO product_account_provisioning_events (product_account_id, event_type)
       VALUES ($1, 'CREATED'), ($1, 'PROVISIONED')`, [accountId],
    );
    await client.query('COMMIT');

    return getAccountAccessForMember(input.ownerUserId, accountId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getAccountAccessForMember(userId: string, accountId: string): Promise<ProductAccountAccess> {
  const account = await productAccounts.findById(accountId);
  if (!account) throw new ProductAccountNotFoundError('Product account not found.');
  const membership = await memberships.findByUserAndBusiness(userId, account.businessId);
  if (!membership || membership.status !== 'active') throw new ProductAccountNotFoundError('Product account membership not found.');

  const trial = await trials.findTrialByProductAccountId(account.id);
  if (trial && trial.state !== 'CONVERTED' && trial.state !== 'CANCELLED') {
    const nextState = deriveTrialState({
      state: trial.state,
      startsAt: trial.startsAt ? new Date(trial.startsAt) : null,
      endsAt: trial.endsAt ? new Date(trial.endsAt) : null,
    });
    if (nextState !== trial.state) await trials.updateState(trial.id, nextState, nextState === 'EXPIRED' ? new Date() : null);
    if (nextState === 'EXPIRED' && account.status === 'ACTIVE') {
      await productAccounts.setStatus(account.id, 'RESTRICTED');
      await productAccounts.recordProvisioningEvent(account.id, 'RESTRICTED');
      account.status = 'RESTRICTED';
    }
  }

  const entitlements = await productAccounts.listEntitlements(account.id);
  return { account, entitlements, operationalAccess: account.status === 'ACTIVE' };
}

export async function getProductAccountAccess(userId: string, accountId: string): Promise<ProductAccountAccess> {
  return getAccountAccessForMember(userId, accountId);
}

export const productEntitlements = PRODUCT_ENTITLEMENTS;

export interface ControlPlaneStats {
  totalBusinesses: number;
  activeWaConnections: number;
  /** Real, non-deleted WhatsApp accounts whose connection_status isn't CONNECTED - paired at some point but not live right now. */
  inactiveWaConnections: number;
  totalAiAgents: number;
  activeTrials: number;
  recentSecurityEvents: number;
  /** This process's own uptime, in whole seconds - Node's own process.uptime(), never a fabricated/cached value. */
  serverUptimeSeconds: number;
}

/** Top-line counts for the developer control plane dashboard and the operator-mode "platform status" command. */
export async function getControlPlaneStats(): Promise<ControlPlaneStats> {
  const { rows } = await pool.query<{
    total_businesses: string;
    active_wa_connections: string;
    inactive_wa_connections: string;
    total_ai_agents: string;
    active_trials: string;
    recent_security_events: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM businesses) AS total_businesses,
      (SELECT COUNT(*) FROM whatsapp_accounts WHERE connection_status = 'CONNECTED' AND deleted_at IS NULL) AS active_wa_connections,
      (SELECT COUNT(*) FROM whatsapp_accounts WHERE connection_status != 'CONNECTED' AND deleted_at IS NULL) AS inactive_wa_connections,
      (SELECT COUNT(*) FROM ai_agents WHERE deleted_at IS NULL) AS total_ai_agents,
      (SELECT COUNT(*) FROM product_trials WHERE state IN ('ACTIVE', 'EXPIRING')) AS active_trials,
      (SELECT COUNT(*) FROM security_audit_logs WHERE created_at > NOW() - INTERVAL '24 hours') AS recent_security_events
  `);
  const row = rows[0];
  return {
    totalBusinesses: Number(row?.total_businesses ?? 0),
    activeWaConnections: Number(row?.active_wa_connections ?? 0),
    inactiveWaConnections: Number(row?.inactive_wa_connections ?? 0),
    totalAiAgents: Number(row?.total_ai_agents ?? 0),
    activeTrials: Number(row?.active_trials ?? 0),
    recentSecurityEvents: Number(row?.recent_security_events ?? 0),
    serverUptimeSeconds: Math.floor(process.uptime()),
  };
}

/** Returns the product_key currently assigned to a business, or null if none. */
export async function getBusinessProductKey(businessId: string): Promise<string | null> {
  const { rows } = await pool.query<{ product_key: string }>(
    `SELECT pc.product_key
       FROM product_accounts pa
       JOIN product_catalog pc ON pa.product_id = pc.id
      WHERE pa.business_id = $1 AND pa.status NOT IN ('CLOSED', 'SUSPENDED')
      LIMIT 1`,
    [businessId],
  );
  return rows[0]?.product_key ?? null;
}

/**
 * Assigns (or re-assigns) a vertical to a business.
 * If a product account already exists, it is updated. If not, one is created.
 * Entitlements are rebuilt for the new vertical.
 */
export async function assignVertical(businessId: string, productKey: ProductKey): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const productResult = await client.query<{ id: string }>(
      `SELECT id FROM product_catalog WHERE product_key = $1 AND is_active = true`, [productKey],
    );
    const productRow = productResult.rows[0];
    if (!productRow) throw new ProductNotFoundError(`Product "${productKey}" not found.`);

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM product_accounts WHERE business_id = $1 LIMIT 1`, [businessId],
    );

    let accountId: string;
    if (existing.rows[0]) {
      accountId = existing.rows[0].id;
      await client.query(
        `UPDATE product_accounts SET product_id = $1, status = 'ACTIVE', updated_at = now() WHERE id = $2`,
        [productRow.id, accountId],
      );
      await client.query(`DELETE FROM product_entitlements WHERE product_account_id = $1`, [accountId]);
    } else {
      const ownerResult = await client.query<{ user_id: string }>(
        `SELECT user_id FROM business_memberships WHERE business_id = $1 AND role = 'OWNER' LIMIT 1`, [businessId],
      );
      const ownerUserId = ownerResult.rows[0]?.user_id ?? null;

      const accountResult = await client.query<{ id: string }>(
        `INSERT INTO product_accounts (business_id, product_id, owner_user_id, status, display_name)
         VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
        [businessId, productRow.id, ownerUserId, productKey],
      );
      accountId = accountResult.rows[0]?.id ?? '';
      if (!accountId) throw new Error('Failed to create product account.');
    }

    for (const key of PRODUCT_ENTITLEMENTS[productKey]) {
      await client.query(
        `INSERT INTO product_entitlements (product_account_id, entitlement_key, is_enabled, source)
         VALUES ($1, $2, true, 'PRODUCT')`, [accountId, key],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
