import type { Queryable } from './types.js';
import type { ProductAccountStatus, ProductEntitlement, ProductKey } from '../domain/platform/productAccounts.js';

interface AccountRow {
  id: string; business_id: string; product_id: string; product_key: ProductKey; owner_user_id: string | null;
  display_name: string; status: ProductAccountStatus; created_at: Date; updated_at: Date;
}
interface EntitlementRow { entitlement_key: string; is_enabled: boolean; limit_value: number | null; source: ProductEntitlement['source']; expires_at: Date | null; }
function toAccount(row: AccountRow) {
  return { id: row.id, businessId: row.business_id, productId: row.product_id, productKey: row.product_key, ownerUserId: row.owner_user_id, displayName: row.display_name, status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
const ACCOUNT_SELECT = `SELECT pa.id, pa.business_id, pa.product_id, pc.product_key, pa.owner_user_id, pa.display_name, pa.status, pa.created_at, pa.updated_at FROM product_accounts pa JOIN product_catalog pc ON pc.id = pa.product_id`;

export class ProductAccountRepository {
  constructor(private readonly db: Queryable) {}
  async findById(id: string) { const { rows } = await this.db.query<AccountRow>(`${ACCOUNT_SELECT} WHERE pa.id = $1`, [id]); return rows[0] ? toAccount(rows[0]) : null; }
  async findByBusinessAndProduct(businessId: string, productKey: ProductKey) { const { rows } = await this.db.query<AccountRow>(`${ACCOUNT_SELECT} WHERE pa.business_id = $1 AND pc.product_key = $2`, [businessId, productKey]); return rows[0] ? toAccount(rows[0]) : null; }
  async findForOwnerAndProduct(ownerUserId: string, productKey: ProductKey) { const { rows } = await this.db.query<AccountRow>(`${ACCOUNT_SELECT} WHERE pa.owner_user_id = $1 AND pc.product_key = $2`, [ownerUserId, productKey]); return rows[0] ? toAccount(rows[0]) : null; }
  async listForOwner(ownerUserId: string) { const { rows } = await this.db.query<AccountRow>(`${ACCOUNT_SELECT} WHERE pa.owner_user_id = $1 ORDER BY pa.created_at ASC`, [ownerUserId]); return rows.map(toAccount); }
  async listAll() { const { rows } = await this.db.query<AccountRow>(`${ACCOUNT_SELECT} ORDER BY pa.created_at ASC`); return rows.map(toAccount); }
  async listProducts() { const { rows } = await this.db.query<{ id: string; product_key: ProductKey; name: string; description: string; is_active: boolean }>(`SELECT id, product_key, name, description, is_active FROM product_catalog WHERE is_active = true ORDER BY name`); return rows; }
  async listEntitlements(productAccountId: string): Promise<ProductEntitlement[]> { const { rows } = await this.db.query<EntitlementRow>(`SELECT entitlement_key, is_enabled, limit_value, source, expires_at FROM product_entitlements WHERE product_account_id = $1 ORDER BY entitlement_key`, [productAccountId]); return rows.map((row) => ({ key: row.entitlement_key, enabled: row.is_enabled, limit: row.limit_value, source: row.source, expiresAt: row.expires_at?.toISOString() ?? null })); }
  async setStatus(id: string, status: ProductAccountStatus): Promise<void> { await this.db.query(`UPDATE product_accounts SET status = $2, updated_at = now() WHERE id = $1`, [id, status]); }
  async recordProvisioningEvent(id: string, eventType: 'CREATED' | 'PROVISIONED' | 'RESTRICTED' | 'REACTIVATED' | 'SUSPENDED' | 'CLOSED'): Promise<void> { await this.db.query(`INSERT INTO product_account_provisioning_events (product_account_id, event_type) VALUES ($1, $2)`, [id, eventType]); }
}
