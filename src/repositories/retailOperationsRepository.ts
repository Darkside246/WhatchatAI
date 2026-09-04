import type { Queryable } from './types.js';

export interface RetailProductRecord {
  id: string; businessId: string; name: string; sku: string | null; category: string; status: string;
  priceCents: number; currency: string; stockQuantity: number | null; description: string | null; imageUrl: string | null;
  metadata: Record<string, unknown>; createdAt: Date; updatedAt: Date;
}
export interface RetailOrderItem { productId: string; name: string; quantity: number; unitPriceCents: number; }
export interface RetailOrderRecord {
  id: string; businessId: string; customerContactId: string | null; sourceChannel: string; status: string;
  items: RetailOrderItem[]; totalCents: number; currency: string; fulfillmentMethod: string; deliveryAddress: string | null;
  notes: string | null; aiSummary: string | null; confidence: number | null; createdAt: Date; updatedAt: Date; fulfilledAt: Date | null;
}
export interface RetailNoteRecord { id: string; businessId: string; productId: string; note: string; createdByJid: string; createdAt: Date; }

function json(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function items(value: unknown): RetailOrderItem[] { return Array.isArray(value) ? value as RetailOrderItem[] : []; }

export class RetailOperationsRepository {
  constructor(private readonly db: Queryable) {}

  async listProducts(businessId: string, category?: string | undefined): Promise<RetailProductRecord[]> {
    const params: unknown[] = [businessId];
    let sql = `SELECT id,business_id AS "businessId",name,sku,category,status,price_cents AS "priceCents",currency,stock_quantity AS "stockQuantity",description,image_url AS "imageUrl",metadata,created_at AS "createdAt",updated_at AS "updatedAt" FROM retail_products WHERE business_id = $1`;
    if (category) { params.push(category); sql += ` AND category = $${params.length}`; }
    sql += ' ORDER BY name';
    const { rows } = await this.db.query<RetailProductRecord>(sql, params);
    return rows.map((r) => ({ ...r, metadata: json(r.metadata) }));
  }

  async getProduct(businessId: string, productId: string): Promise<RetailProductRecord | null> {
    const { rows } = await this.db.query<RetailProductRecord>(`SELECT id,business_id AS "businessId",name,sku,category,status,price_cents AS "priceCents",currency,stock_quantity AS "stockQuantity",description,image_url AS "imageUrl",metadata,created_at AS "createdAt",updated_at AS "updatedAt" FROM retail_products WHERE business_id = $1 AND id = $2`, [businessId, productId]);
    const row = rows[0];
    return row ? { ...row, metadata: json(row.metadata) } : null;
  }

  async createProduct(input: { id: string; businessId: string; name: string; sku?: string | undefined; category?: string | undefined; status?: string | undefined; priceCents?: number | undefined; currency?: string | undefined; stockQuantity?: number | undefined; description?: string | undefined; imageUrl?: string | undefined; metadata?: Record<string, unknown> | undefined }): Promise<RetailProductRecord> {
    const { rows } = await this.db.query<RetailProductRecord>(
      `INSERT INTO retail_products (id,business_id,name,sku,category,status,price_cents,currency,stock_quantity,description,image_url,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id,business_id AS "businessId",name,sku,category,status,price_cents AS "priceCents",currency,stock_quantity AS "stockQuantity",description,image_url AS "imageUrl",metadata,created_at AS "createdAt",updated_at AS "updatedAt"`,
      [input.id, input.businessId, input.name, input.sku ?? null, input.category ?? 'GENERAL', input.status ?? 'ACTIVE', input.priceCents ?? 0, input.currency ?? 'USD', input.stockQuantity ?? null, input.description ?? null, input.imageUrl ?? null, JSON.stringify(input.metadata ?? {})],
    );
    if (!rows[0]) throw new Error('product insert returned no row');
    return { ...rows[0], metadata: json(rows[0].metadata) };
  }

  /** Best-effort stock adjustment - only applies to stock-tracked products (stock_quantity IS NOT NULL); a non-tracked product's row is simply left untouched. */
  async updateProductStock(businessId: string, productId: string, delta: number): Promise<RetailProductRecord | null> {
    const { rows } = await this.db.query<RetailProductRecord>(
      `UPDATE retail_products SET stock_quantity = GREATEST(stock_quantity + $3, 0), updated_at = now() WHERE business_id = $1 AND id = $2 AND stock_quantity IS NOT NULL RETURNING id,business_id AS "businessId",name,sku,category,status,price_cents AS "priceCents",currency,stock_quantity AS "stockQuantity",description,image_url AS "imageUrl",metadata,created_at AS "createdAt",updated_at AS "updatedAt"`,
      [businessId, productId, delta],
    );
    const row = rows[0];
    return row ? { ...row, metadata: json(row.metadata) } : null;
  }

  /** Case-insensitive partial match on name - the AI order-intake flow and the customer-facing tools take free text, not an id. Ambiguous (>1 match) is the caller's problem to report honestly, not something this method resolves by guessing. */
  async findProductsByNameForBusiness(businessId: string, ref: string): Promise<RetailProductRecord[]> {
    const { rows } = await this.db.query<RetailProductRecord>(`SELECT id,business_id AS "businessId",name,sku,category,status,price_cents AS "priceCents",currency,stock_quantity AS "stockQuantity",description,image_url AS "imageUrl",metadata,created_at AS "createdAt",updated_at AS "updatedAt" FROM retail_products WHERE business_id = $1 AND name ILIKE $2 ORDER BY name LIMIT 5`, [businessId, `%${ref}%`]);
    return rows.map((r) => ({ ...r, metadata: json(r.metadata) }));
  }

  async createOrder(input: { id: string; businessId: string; customerContactId?: string | undefined; sourceChannel: string; items: RetailOrderItem[]; totalCents: number; currency?: string | undefined; fulfillmentMethod?: string | undefined; deliveryAddress?: string | undefined; notes?: string | undefined; aiSummary?: string | undefined; confidence?: number | undefined; status?: string | undefined }): Promise<RetailOrderRecord> {
    const { rows } = await this.db.query<RetailOrderRecord>(
      `INSERT INTO retail_orders (id,business_id,customer_contact_id,source_channel,status,items,total_cents,currency,fulfillment_method,delivery_address,notes,ai_summary,confidence) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13) RETURNING id,business_id AS "businessId",customer_contact_id AS "customerContactId",source_channel AS "sourceChannel",status,items,total_cents AS "totalCents",currency,fulfillment_method AS "fulfillmentMethod",delivery_address AS "deliveryAddress",notes,ai_summary AS "aiSummary",confidence,created_at AS "createdAt",updated_at AS "updatedAt",fulfilled_at AS "fulfilledAt"`,
      [input.id, input.businessId, input.customerContactId ?? null, input.sourceChannel, input.status ?? 'PENDING_APPROVAL', JSON.stringify(input.items), input.totalCents, input.currency ?? 'USD', input.fulfillmentMethod ?? 'PICKUP', input.deliveryAddress ?? null, input.notes ?? null, input.aiSummary ?? null, input.confidence ?? null],
    );
    if (!rows[0]) throw new Error('order insert returned no row');
    return { ...rows[0], items: items(rows[0].items) };
  }

  async listOrders(businessId: string, status?: string | undefined): Promise<RetailOrderRecord[]> {
    const params: unknown[] = [businessId];
    let sql = `SELECT id,business_id AS "businessId",customer_contact_id AS "customerContactId",source_channel AS "sourceChannel",status,items,total_cents AS "totalCents",currency,fulfillment_method AS "fulfillmentMethod",delivery_address AS "deliveryAddress",notes,ai_summary AS "aiSummary",confidence,created_at AS "createdAt",updated_at AS "updatedAt",fulfilled_at AS "fulfilledAt" FROM retail_orders WHERE business_id = $1`;
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await this.db.query<RetailOrderRecord>(sql, params);
    return rows.map((r) => ({ ...r, items: items(r.items) }));
  }

  async getOrder(businessId: string, orderId: string): Promise<RetailOrderRecord | null> {
    const { rows } = await this.db.query<RetailOrderRecord>(`SELECT id,business_id AS "businessId",customer_contact_id AS "customerContactId",source_channel AS "sourceChannel",status,items,total_cents AS "totalCents",currency,fulfillment_method AS "fulfillmentMethod",delivery_address AS "deliveryAddress",notes,ai_summary AS "aiSummary",confidence,created_at AS "createdAt",updated_at AS "updatedAt",fulfilled_at AS "fulfilledAt" FROM retail_orders WHERE business_id = $1 AND id = $2`, [businessId, orderId]);
    const row = rows[0];
    return row ? { ...row, items: items(row.items) } : null;
  }

  /** Stamps fulfilled_at once via CASE WHEN ... COALESCE, same idiom as propertyOperationsRepository's updateIncidentStatus/updateWorkOrder - a re-transition to FULFILLED never overwrites an earlier fulfillment timestamp. */
  async updateOrderStatus(businessId: string, orderId: string, status: 'PENDING_APPROVAL' | 'PENDING_POLICY' | 'APPROVED' | 'FULFILLED' | 'CANCELLED', options?: { notes?: string | undefined }): Promise<RetailOrderRecord | null> {
    const fulfilled = status === 'FULFILLED';
    const { rows } = await this.db.query<RetailOrderRecord>(
      `UPDATE retail_orders SET status=$3,notes=COALESCE($4,notes),fulfilled_at=CASE WHEN $5 THEN COALESCE(fulfilled_at,now()) ELSE fulfilled_at END,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING id,business_id AS "businessId",customer_contact_id AS "customerContactId",source_channel AS "sourceChannel",status,items,total_cents AS "totalCents",currency,fulfillment_method AS "fulfillmentMethod",delivery_address AS "deliveryAddress",notes,ai_summary AS "aiSummary",confidence,created_at AS "createdAt",updated_at AS "updatedAt",fulfilled_at AS "fulfilledAt"`,
      [businessId, orderId, status, options?.notes ?? null, fulfilled],
    );
    const row = rows[0];
    return row ? { ...row, items: items(row.items) } : null;
  }

  async createRetailNote(input: { id: string; businessId: string; productId: string; note: string; createdByJid: string }): Promise<RetailNoteRecord> {
    const { rows } = await this.db.query<RetailNoteRecord>(`INSERT INTO retail_notes (id,business_id,product_id,note,created_by_jid) VALUES ($1,$2,$3,$4,$5) RETURNING id,business_id AS "businessId",product_id AS "productId",note,created_by_jid AS "createdByJid",created_at AS "createdAt"`, [input.id, input.businessId, input.productId, input.note, input.createdByJid]);
    if (!rows[0]) throw new Error('retail note insert returned no row');
    return rows[0];
  }

  async listRetailNotes(businessId: string, productId: string, limit = 20): Promise<RetailNoteRecord[]> {
    const { rows } = await this.db.query<RetailNoteRecord>(`SELECT id,business_id AS "businessId",product_id AS "productId",note,created_by_jid AS "createdByJid",created_at AS "createdAt" FROM retail_notes WHERE business_id = $1 AND product_id = $2 ORDER BY created_at DESC LIMIT $3`, [businessId, productId, limit]);
    return rows;
  }
}
