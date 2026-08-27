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
  property: ['property.dashboard', 'property.conversations', 'property.maintenance', 'property.work_orders', 'property.properties', 'property.vendors', 'property.reports'],
  food: ['food.dashboard', 'food.conversations', 'food.orders', 'food.menu', 'food.kitchen', 'food.pickup_delivery', 'food.customers', 'food.reports'],
  commerce: ['commerce.dashboard', 'commerce.quotes', 'commerce.invoices', 'commerce.inventory', 'commerce.customers'],
  scheduling: ['scheduling.dashboard', 'scheduling.appointments', 'scheduling.availability'],
  support: ['support.dashboard', 'support.conversations', 'support.handoff', 'support.reports'],
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
