import { pool } from '../../db/pool.js';
import { ProductAccountRepository } from '../../repositories/productAccountRepository.js';

const productAccountRepository = new ProductAccountRepository(pool);

/**
 * Fail-closed by design: a business with no product_entitlements row at all
 * for `key` (the common case for a brand-new capability like the AI
 * personal-assistant mode) is NOT entitled, on every one of its product
 * accounts, until something explicitly grants it - never assumed available
 * just because the business exists or has an active account. Checks every
 * ACTIVE product account the business has (a business can hold more than
 * one vertical), so an entitlement granted on any one of them is enough.
 */
export async function hasEntitlement(businessId: string, entitlementKey: string): Promise<boolean> {
  const accounts = await productAccountRepository.listByBusiness(businessId);
  for (const account of accounts) {
    if (account.status !== 'ACTIVE') continue;
    const entitlements = await productAccountRepository.listEntitlements(account.id);
    const match = entitlements.find((entitlement) => entitlement.key === entitlementKey);
    if (!match || !match.enabled) continue;
    if (match.expiresAt && new Date(match.expiresAt).getTime() <= Date.now()) continue;
    return true;
  }
  return false;
}
