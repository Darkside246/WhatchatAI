import type { Queryable } from './types.js';
import type { FoodOrderStage, FulfilmentMethod } from '../domain/food/orderLifecycle.js';
import { canTransition, isOpenStage, OPEN_STAGES } from '../domain/food/orderLifecycle.js';

export interface FoodMenuItemRecord {
  id: string;
  businessId: string;
  name: string;
  sku: string | null;
  category: string;
  description: string | null;
  priceCents: number;
  currency: string;
  /** The "86" toggle - false the moment the kitchen runs out. */
  available: boolean;
  /** What customers really call it, so an operator can fix a misread order without a code change. */
  aliases: string[];
  variants: unknown[];
  modifiers: unknown[];
  station: string | null;
  allergens: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FoodOrderLine {
  menuItemId: string | null;
  name: string;
  variant: string | null;
  quantity: number;
  unitPriceCents: number;
  modifiers: { name: string; action: 'add' | 'remove' | 'on_side'; priceDeltaCents: number }[];
  notes: string | null;
}

export interface FoodOrderRecord {
  id: string;
  businessId: string;
  orderNumber: number;
  chatId: string | null;
  customerContactId: string | null;
  stage: FoodOrderStage;
  fulfilmentMethod: FulfilmentMethod;
  customerName: string | null;
  customerPhone: string | null;
  items: FoodOrderLine[];
  subtotalCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  deliveryAddress: string | null;
  deliveryNotes: string | null;
  allergenNotes: string | null;
  kitchenNotes: string | null;
  scheduledFor: string | null;
  placedAt: string;
  closedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FoodOrderEventRecord {
  id: string;
  orderId: string;
  fromStage: FoodOrderStage | null;
  toStage: FoodOrderStage;
  actorUserId: string | null;
  actorKind: 'user' | 'ai' | 'system' | 'customer';
  note: string | null;
  createdAt: string;
}

export interface FoodDeliveryZoneRecord {
  id: string;
  businessId: string;
  name: string;
  centreLatitude: number;
  centreLongitude: number;
  radiusMetres: number;
  feeCents: number;
  minimumOrderCents: number;
  active: boolean;
}

interface MenuItemRow {
  id: string; business_id: string; name: string; sku: string | null; category: string; description: string | null;
  price_cents: string; currency: string; available: boolean; aliases: string[]; variants: unknown[]; modifiers: unknown[];
  station: string | null; allergens: string[]; created_at: string; updated_at: string;
}

interface OrderRow {
  id: string; business_id: string; order_number: string; chat_id: string | null; customer_contact_id: string | null;
  stage: FoodOrderStage; fulfilment_method: FulfilmentMethod; customer_name: string | null; customer_phone: string | null;
  items: FoodOrderLine[]; subtotal_cents: string; delivery_fee_cents: string; tax_cents: string; total_cents: string;
  currency: string; delivery_latitude: number | null; delivery_longitude: number | null; delivery_address: string | null;
  delivery_notes: string | null; allergen_notes: string | null; kitchen_notes: string | null; scheduled_for: string | null;
  placed_at: string; closed_at: string | null; cancel_reason: string | null; created_at: string; updated_at: string;
}

interface EventRow {
  id: string; order_id: string; from_stage: FoodOrderStage | null; to_stage: FoodOrderStage;
  actor_user_id: string | null; actor_kind: 'user' | 'ai' | 'system' | 'customer'; note: string | null; created_at: string;
}

interface ZoneRow {
  id: string; business_id: string; name: string; centre_latitude: number; centre_longitude: number;
  radius_metres: number; fee_cents: string; minimum_order_cents: string; active: boolean;
}

function toMenuItem(row: MenuItemRow): FoodMenuItemRecord {
  return {
    id: row.id, businessId: row.business_id, name: row.name, sku: row.sku, category: row.category,
    description: row.description, priceCents: Number(row.price_cents), currency: row.currency,
    available: row.available, aliases: row.aliases ?? [], variants: row.variants ?? [], modifiers: row.modifiers ?? [],
    station: row.station, allergens: row.allergens ?? [], createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toOrder(row: OrderRow): FoodOrderRecord {
  return {
    id: row.id, businessId: row.business_id, orderNumber: Number(row.order_number), chatId: row.chat_id,
    customerContactId: row.customer_contact_id, stage: row.stage, fulfilmentMethod: row.fulfilment_method,
    customerName: row.customer_name, customerPhone: row.customer_phone, items: row.items ?? [],
    subtotalCents: Number(row.subtotal_cents), deliveryFeeCents: Number(row.delivery_fee_cents),
    taxCents: Number(row.tax_cents), totalCents: Number(row.total_cents), currency: row.currency,
    deliveryLatitude: row.delivery_latitude, deliveryLongitude: row.delivery_longitude,
    deliveryAddress: row.delivery_address, deliveryNotes: row.delivery_notes, allergenNotes: row.allergen_notes,
    kitchenNotes: row.kitchen_notes, scheduledFor: row.scheduled_for, placedAt: row.placed_at,
    closedAt: row.closed_at, cancelReason: row.cancel_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export interface CreateFoodOrderInput {
  businessId: string;
  chatId?: string | null;
  customerContactId?: string | null;
  fulfilmentMethod: FulfilmentMethod;
  customerName?: string | null;
  customerPhone?: string | null;
  items: FoodOrderLine[];
  subtotalCents: number;
  deliveryFeeCents?: number;
  taxCents?: number;
  totalCents: number;
  currency?: string;
  deliveryLatitude?: number | null;
  deliveryLongitude?: number | null;
  deliveryAddress?: string | null;
  deliveryNotes?: string | null;
  allergenNotes?: string | null;
  kitchenNotes?: string | null;
  scheduledFor?: string | null;
}

/** Raised when a stage change is not one the lifecycle permits - see domain/food/orderLifecycle.ts. */
export class IllegalStageTransitionError extends Error {}

export class FoodOperationsRepository {
  constructor(private readonly db: Queryable) {}

  // ── Menu ───────────────────────────────────────────────────────────────

  async listMenu(businessId: string, options: { availableOnly?: boolean } = {}): Promise<FoodMenuItemRecord[]> {
    const { rows } = await this.db.query<MenuItemRow>(
      `SELECT * FROM food_menu_items
       WHERE business_id = $1 AND ($2::boolean IS NOT TRUE OR available = true)
       ORDER BY category, name`,
      [businessId, options.availableOnly ?? false],
    );
    return rows.map(toMenuItem);
  }

  async createMenuItem(input: {
    businessId: string; name: string; priceCents: number; category?: string; sku?: string | null;
    description?: string | null; currency?: string; aliases?: string[]; variants?: unknown[]; modifiers?: unknown[];
    station?: string | null; allergens?: string[];
  }): Promise<FoodMenuItemRecord> {
    const { rows } = await this.db.query<MenuItemRow>(
      `INSERT INTO food_menu_items
         (business_id, name, sku, category, description, price_cents, currency, aliases, variants, modifiers, station, allergens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.businessId, input.name, input.sku ?? null, input.category ?? 'GENERAL', input.description ?? null,
        input.priceCents, input.currency ?? 'USD', input.aliases ?? [], JSON.stringify(input.variants ?? []),
        JSON.stringify(input.modifiers ?? []), input.station ?? null, input.allergens ?? [],
      ],
    );
    return toMenuItem(rows[0]!);
  }

  /**
   * The "86" toggle - one write, because a kitchen that has just run out of
   * something needs it gone from ordering in the time it takes to say so.
   */
  async setMenuItemAvailability(businessId: string, id: string, available: boolean): Promise<FoodMenuItemRecord | null> {
    const { rows } = await this.db.query<MenuItemRow>(
      `UPDATE food_menu_items SET available = $3, updated_at = now()
       WHERE business_id = $1 AND id = $2 RETURNING *`,
      [businessId, id, available],
    );
    return rows[0] ? toMenuItem(rows[0]) : null;
  }

  // ── Orders ─────────────────────────────────────────────────────────────

  /**
   * Takes the next order number for this business atomically.
   *
   * A single UPSERT rather than a read-then-write, so two orders taken in
   * the same instant - which on a Friday night is not hypothetical - cannot
   * be given the same number.
   */
  private async nextOrderNumber(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ next_number: string }>(
      `INSERT INTO food_order_numbers (business_id, next_number) VALUES ($1, 2)
       ON CONFLICT (business_id) DO UPDATE SET next_number = food_order_numbers.next_number + 1
       RETURNING food_order_numbers.next_number - 1 AS next_number`,
      [businessId],
    );
    return Number(rows[0]!.next_number);
  }

  async createOrder(input: CreateFoodOrderInput): Promise<FoodOrderRecord> {
    const orderNumber = await this.nextOrderNumber(input.businessId);
    const { rows } = await this.db.query<OrderRow>(
      `INSERT INTO food_orders
         (business_id, order_number, chat_id, customer_contact_id, fulfilment_method, customer_name, customer_phone,
          items, subtotal_cents, delivery_fee_cents, tax_cents, total_cents, currency,
          delivery_latitude, delivery_longitude, delivery_address, delivery_notes,
          allergen_notes, kitchen_notes, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        input.businessId, orderNumber, input.chatId ?? null, input.customerContactId ?? null, input.fulfilmentMethod,
        input.customerName ?? null, input.customerPhone ?? null, JSON.stringify(input.items),
        input.subtotalCents, input.deliveryFeeCents ?? 0, input.taxCents ?? 0, input.totalCents, input.currency ?? 'USD',
        input.deliveryLatitude ?? null, input.deliveryLongitude ?? null, input.deliveryAddress ?? null,
        input.deliveryNotes ?? null, input.allergenNotes ?? null, input.kitchenNotes ?? null, input.scheduledFor ?? null,
      ],
    );
    const order = toOrder(rows[0]!);
    await this.recordEvent(input.businessId, order.id, { fromStage: null, toStage: 'NEW', actorKind: 'customer' });
    return order;
  }

  /** Everything still somebody's job, oldest first - the oldest ticket is the one closest to breaching. */
  async listBoard(businessId: string): Promise<FoodOrderRecord[]> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT * FROM food_orders
       WHERE business_id = $1 AND stage = ANY($2::text[])
       ORDER BY placed_at ASC`,
      [businessId, [...OPEN_STAGES]],
    );
    return rows.map(toOrder);
  }

  async findOrder(businessId: string, id: string): Promise<FoodOrderRecord | null> {
    const { rows } = await this.db.query<OrderRow>(
      'SELECT * FROM food_orders WHERE business_id = $1 AND id = $2',
      [businessId, id],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  /** Every order from one conversation, newest first - what the board shows beside the chat. */
  async listOrdersForChat(businessId: string, chatId: string, limit = 20): Promise<FoodOrderRecord[]> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT * FROM food_orders WHERE business_id = $1 AND chat_id = $2 ORDER BY placed_at DESC LIMIT $3`,
      [businessId, chatId, limit],
    );
    return rows.map(toOrder);
  }

  /**
   * Moves an order to its next stage, refusing anything the lifecycle does
   * not permit.
   *
   * The guard is here rather than only in the service because this is the
   * one place every caller - a bump bar, an API route, the AI - has to come
   * through. A board that could be driven into an impossible state by one
   * unguarded caller is a board nobody can trust during a rush.
   *
   * Returns null when the order does not exist for this business; throws
   * only for a move that is real but illegal, which is a caller bug rather
   * than a missing row.
   */
  async moveToStage(
    businessId: string,
    id: string,
    to: FoodOrderStage,
    actor: { userId?: string | null; kind?: FoodOrderEventRecord['actorKind']; note?: string | null } = {},
  ): Promise<FoodOrderRecord | null> {
    const existing = await this.findOrder(businessId, id);
    if (!existing) return null;

    if (existing.stage === to) return existing;
    if (!canTransition(existing.stage, to)) {
      throw new IllegalStageTransitionError(`An order cannot move from ${existing.stage} to ${to}.`);
    }

    const { rows } = await this.db.query<OrderRow>(
      `UPDATE food_orders
         SET stage = $3,
             /* Stamped once, when the order stops being live, so a finished
                ticket stops ageing in a history view. */
             closed_at = CASE WHEN $4::boolean THEN NULL ELSE COALESCE(closed_at, now()) END,
             cancel_reason = CASE WHEN $3 = 'CANCELLED' THEN COALESCE($5, cancel_reason) ELSE cancel_reason END,
             updated_at = now()
       WHERE business_id = $1 AND id = $2
       RETURNING *`,
      [businessId, id, to, isOpenStage(to), actor.note ?? null],
    );

    await this.recordEvent(businessId, id, {
      fromStage: existing.stage,
      toStage: to,
      actorUserId: actor.userId ?? null,
      actorKind: actor.kind ?? 'user',
      note: actor.note ?? null,
    });

    return rows[0] ? toOrder(rows[0]) : null;
  }

  async recordEvent(
    businessId: string,
    orderId: string,
    event: { fromStage: FoodOrderStage | null; toStage: FoodOrderStage; actorUserId?: string | null; actorKind?: FoodOrderEventRecord['actorKind']; note?: string | null },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO food_order_events (business_id, order_id, from_stage, to_stage, actor_user_id, actor_kind, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [businessId, orderId, event.fromStage, event.toStage, event.actorUserId ?? null, event.actorKind ?? 'user', event.note ?? null],
    );
  }

  async listEvents(businessId: string, orderId: string): Promise<FoodOrderEventRecord[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT * FROM food_order_events WHERE business_id = $1 AND order_id = $2 ORDER BY created_at ASC`,
      [businessId, orderId],
    );
    return rows.map((row) => ({
      id: row.id, orderId: row.order_id, fromStage: row.from_stage, toStage: row.to_stage,
      actorUserId: row.actor_user_id, actorKind: row.actor_kind, note: row.note, createdAt: row.created_at,
    }));
  }

  // ── Delivery zones ─────────────────────────────────────────────────────

  async listZones(businessId: string): Promise<FoodDeliveryZoneRecord[]> {
    const { rows } = await this.db.query<ZoneRow>(
      'SELECT * FROM food_delivery_zones WHERE business_id = $1 AND active = true ORDER BY radius_metres ASC',
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id, businessId: row.business_id, name: row.name,
      centreLatitude: row.centre_latitude, centreLongitude: row.centre_longitude,
      radiusMetres: row.radius_metres, feeCents: Number(row.fee_cents),
      minimumOrderCents: Number(row.minimum_order_cents), active: row.active,
    }));
  }

  async createZone(input: Omit<FoodDeliveryZoneRecord, 'id' | 'active'> & { active?: boolean }): Promise<FoodDeliveryZoneRecord> {
    const { rows } = await this.db.query<ZoneRow>(
      `INSERT INTO food_delivery_zones (business_id, name, centre_latitude, centre_longitude, radius_metres, fee_cents, minimum_order_cents, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [input.businessId, input.name, input.centreLatitude, input.centreLongitude, input.radiusMetres, input.feeCents, input.minimumOrderCents, input.active ?? true],
    );
    const row = rows[0]!;
    return {
      id: row.id, businessId: row.business_id, name: row.name,
      centreLatitude: row.centre_latitude, centreLongitude: row.centre_longitude,
      radiusMetres: row.radius_metres, feeCents: Number(row.fee_cents),
      minimumOrderCents: Number(row.minimum_order_cents), active: row.active,
    };
  }
}
