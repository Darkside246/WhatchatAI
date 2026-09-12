import type { Queryable } from './types.js';
import type { FoodOrderStage, FulfilmentMethod } from '../domain/food/orderLifecycle.js';
import { canTransition, isOpenStage, OPEN_STAGES } from '../domain/food/orderLifecycle.js';
import type { FoodPaymentMethod, FoodPaymentState, KitchenRelease } from '../domain/food/paymentGate.js';
import { canTransitionPayment, releaseToKitchen } from '../domain/food/paymentGate.js';

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

export interface FoodSettingsRecord {
  businessId: string;
  paymentRequiredBeforeKitchen: boolean;
  tableServiceEnabled: boolean;
  paymentRequiredNotice: string | null;
  slaWarningSeconds: number | null;
  slaBreachSeconds: number | null;
}

export interface FoodCustomerTermsRecord {
  id: string;
  contactId: string | null;
  phoneNumber: string | null;
  allowPayOnDelivery: boolean;
  note: string | null;
  grantedAt: string;
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
  paymentState: FoodPaymentState;
  paymentMethod: FoodPaymentMethod | null;
  paymentReference: string | null;
  paidAt: string | null;
  paymentWaiverKind: 'customer_terms' | 'manual' | null;
  paymentWaiverReason: string | null;
  tableLabel: string | null;
  idempotencyKey: string | null;
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
  payment_state: FoodPaymentState; payment_method: FoodPaymentMethod | null; payment_reference: string | null;
  paid_at: string | null; payment_waiver_kind: 'customer_terms' | 'manual' | null; payment_waiver_reason: string | null;
  table_label: string | null; idempotency_key: string | null;
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
    kitchenNotes: row.kitchen_notes, scheduledFor: row.scheduled_for,
    paymentState: row.payment_state, paymentMethod: row.payment_method, paymentReference: row.payment_reference,
    paidAt: row.paid_at, paymentWaiverKind: row.payment_waiver_kind, paymentWaiverReason: row.payment_waiver_reason,
    tableLabel: row.table_label, idempotencyKey: row.idempotency_key, placedAt: row.placed_at,
    closedAt: row.closed_at, cancelReason: row.cancel_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export interface CreateFoodOrderInput {
  businessId: string;
  /**
   * Derived from the confirming message, so a repeated webhook, a double
   * tap on confirm, or a worker retry all resolve to the SAME order rather
   * than three tickets for one customer. Omitted for an order keyed in by
   * hand at a counter, which has no originating message.
   */
  idempotencyKey?: string | null;
  tableLabel?: string | null;
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

/** Raised when a payment-state change is not one the payment machine permits - see domain/food/paymentGate.ts. */
export class IllegalPaymentTransitionError extends Error {}

/**
 * Raised when a dine-in order is taken by a business that has not turned
 * table service on.
 *
 * Refused rather than quietly downgraded to collection: an order silently
 * changed from dine-in to takeaway is a customer sitting at a table
 * waiting for food that is being packed in a bag.
 */
export class TableServiceDisabledError extends Error {}

/**
 * Raised when an order was sent to the kitchen without payment clearing.
 *
 * Carries the sentence meant for the CUSTOMER as well as the operational
 * reason: somebody is waiting on food and is entitled to know why it has
 * not started, so a blocked release must never be a silent no-op.
 */
export class KitchenPaymentGateError extends Error {
  constructor(message: string, readonly customerFacing: string) {
    super(message);
  }
}

export class FoodOperationsRepository {
  constructor(private readonly db: Queryable) {}


  // ── Settings and customer terms ────────────────────────────────────────

  /**
   * This business's food settings, with defaults for one that has never
   * opened the page.
   *
   * Read-only and lazily defaulted rather than inserting a row on first
   * read: gathering settings must never have the side effect of creating a
   * record, and the defaults are the honest answer for a business that has
   * not chosen yet.
   */
  async getSettings(businessId: string): Promise<FoodSettingsRecord> {
    const { rows } = await this.db.query<{
      payment_required_before_kitchen: boolean; table_service_enabled: boolean;
      payment_required_notice: string | null; sla_warning_seconds: number | null; sla_breach_seconds: number | null;
    }>('SELECT * FROM food_settings WHERE business_id = $1', [businessId]);

    const row = rows[0];
    return {
      businessId,
      // Defaults chosen to protect a business that has not thought about
      // this yet: wait for money, and do not show a table field.
      paymentRequiredBeforeKitchen: row?.payment_required_before_kitchen ?? true,
      tableServiceEnabled: row?.table_service_enabled ?? false,
      paymentRequiredNotice: row?.payment_required_notice ?? null,
      slaWarningSeconds: row?.sla_warning_seconds ?? null,
      slaBreachSeconds: row?.sla_breach_seconds ?? null,
    };
  }

  async saveSettings(
    businessId: string,
    patch: { [K in keyof Omit<FoodSettingsRecord, 'businessId'>]?: FoodSettingsRecord[K] | undefined },
    updatedBy: string | null,
  ): Promise<FoodSettingsRecord> {
    const current = await this.getSettings(businessId);
    // Only keys the caller actually sent are applied, so a patch carrying
    // an explicit undefined cannot blank a setting somebody relies on.
    const next: FoodSettingsRecord = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    await this.db.query(
      `INSERT INTO food_settings
         (business_id, payment_required_before_kitchen, table_service_enabled, payment_required_notice, sla_warning_seconds, sla_breach_seconds, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id) DO UPDATE
         SET payment_required_before_kitchen = EXCLUDED.payment_required_before_kitchen,
             table_service_enabled = EXCLUDED.table_service_enabled,
             payment_required_notice = EXCLUDED.payment_required_notice,
             sla_warning_seconds = EXCLUDED.sla_warning_seconds,
             sla_breach_seconds = EXCLUDED.sla_breach_seconds,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [businessId, next.paymentRequiredBeforeKitchen, next.tableServiceEnabled, next.paymentRequiredNotice, next.slaWarningSeconds, next.slaBreachSeconds, updatedBy],
    );
    return next;
  }

  /**
   * Whether this business will cook for this customer before being paid.
   *
   * Matched on the contact first and the phone number second, because the
   * contact follows the person as their identity resolves while a number
   * is what an operator has to hand when granting terms.
   */
  async findCustomerTerms(
    businessId: string,
    who: { contactId?: string | null; phoneNumber?: string | null },
  ): Promise<FoodCustomerTermsRecord | null> {
    if (!who.contactId && !who.phoneNumber) return null;
    const { rows } = await this.db.query<{
      id: string; contact_id: string | null; phone_number: string | null;
      allow_pay_on_delivery: boolean; note: string | null; granted_at: string;
    }>(
      `SELECT * FROM food_customer_terms
       WHERE business_id = $1 AND revoked_at IS NULL
         AND (($2::uuid IS NOT NULL AND contact_id = $2::uuid) OR ($3::text IS NOT NULL AND phone_number = $3::text))
       ORDER BY granted_at DESC LIMIT 1`,
      [businessId, who.contactId ?? null, who.phoneNumber ?? null],
    );
    const row = rows[0];
    return row
      ? { id: row.id, contactId: row.contact_id, phoneNumber: row.phone_number, allowPayOnDelivery: row.allow_pay_on_delivery, note: row.note, grantedAt: row.granted_at }
      : null;
  }

  async grantCustomerTerms(input: {
    businessId: string; contactId?: string | null; phoneNumber?: string | null; note?: string | null; grantedBy?: string | null;
  }): Promise<FoodCustomerTermsRecord> {
    const { rows } = await this.db.query<{
      id: string; contact_id: string | null; phone_number: string | null;
      allow_pay_on_delivery: boolean; note: string | null; granted_at: string;
    }>(
      `INSERT INTO food_customer_terms (business_id, contact_id, phone_number, note, granted_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.businessId, input.contactId ?? null, input.phoneNumber ?? null, input.note ?? null, input.grantedBy ?? null],
    );
    const row = rows[0]!;
    return { id: row.id, contactId: row.contact_id, phoneNumber: row.phone_number, allowPayOnDelivery: row.allow_pay_on_delivery, note: row.note, grantedAt: row.granted_at };
  }

  /** Revoked rather than deleted, so a standing exemption that existed stays visible in history. */
  async revokeCustomerTerms(businessId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE food_customer_terms SET revoked_at = now() WHERE business_id = $1 AND id = $2 AND revoked_at IS NULL',
      [businessId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async findOrderByIdempotencyKey(businessId: string, key: string): Promise<FoodOrderRecord | null> {
    const { rows } = await this.db.query<OrderRow>(
      'SELECT * FROM food_orders WHERE business_id = $1 AND idempotency_key = $2',
      [businessId, key],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  // ── Payment ────────────────────────────────────────────────────────────

  /**
   * Records a payment-state change, and nothing else.
   *
   * Deliberately does NOT move the order towards the kitchen. Payment
   * clearing makes an order ELIGIBLE to be cooked; a person or an explicit
   * release still decides that it is. Coupling the two here would mean a
   * provider webhook could push food onto a line at four in the morning.
   */
  async recordPayment(
    businessId: string,
    orderId: string,
    to: FoodPaymentState,
    detail: {
      method?: FoodPaymentMethod | null;
      reference?: string | null;
      amountCents?: number | null;
      actorUserId?: string | null;
      actorKind?: 'user' | 'ai' | 'system' | 'customer' | 'provider';
      note?: string | null;
      waiverReason?: string | null;
    } = {},
  ): Promise<FoodOrderRecord | null> {
    const existing = await this.findOrder(businessId, orderId);
    if (!existing) return null;
    if (existing.paymentState === to) return existing;

    if (!canTransitionPayment(existing.paymentState, to)) {
      throw new IllegalPaymentTransitionError(`Payment cannot move from ${existing.paymentState} to ${to}.`);
    }

    const { rows } = await this.db.query<OrderRow>(
      `UPDATE food_orders
         SET payment_state = $3,
             payment_method = COALESCE($4, payment_method),
             payment_reference = COALESCE($5, payment_reference),
             /* Stamped only when money actually arrived, and only once. A
                waiver is not a payment and must never set this. */
             paid_at = CASE WHEN $3 = 'PAID' THEN COALESCE(paid_at, now()) ELSE paid_at END,
             payment_waiver_kind = CASE WHEN $3 = 'WAIVED' THEN 'manual' ELSE payment_waiver_kind END,
             payment_waiver_reason = CASE WHEN $3 = 'WAIVED' THEN COALESCE($6, payment_waiver_reason) ELSE payment_waiver_reason END,
             payment_waived_by = CASE WHEN $3 = 'WAIVED' THEN $7 ELSE payment_waived_by END,
             updated_at = now()
       WHERE business_id = $1 AND id = $2
       RETURNING *`,
      [businessId, orderId, to, detail.method ?? null, detail.reference ?? null, detail.waiverReason ?? null, detail.actorUserId ?? null],
    );

    await this.db.query(
      `INSERT INTO food_payment_events (business_id, order_id, from_state, to_state, method, amount_cents, reference, actor_user_id, actor_kind, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        businessId, orderId, existing.paymentState, to, detail.method ?? null,
        detail.amountCents ?? null, detail.reference ?? null,
        detail.actorUserId ?? null, detail.actorKind ?? 'user', detail.note ?? null,
      ],
    );

    return rows[0] ? toOrder(rows[0]) : null;
  }

  /**
   * Whether this order may go to the kitchen right now, and why not.
   *
   * Exposed so a board can show the answer BEFORE somebody presses a
   * button that will be refused - a bump that silently does nothing is the
   * worst possible behaviour on a screen somebody is working at speed.
   */
  async checkKitchenRelease(businessId: string, orderId: string): Promise<KitchenRelease | null> {
    const order = await this.findOrder(businessId, orderId);
    if (!order) return null;
    const settings = await this.getSettings(businessId);
    return releaseToKitchen({
      paymentState: order.paymentState,
      paymentRequiredBeforeKitchen: settings.paymentRequiredBeforeKitchen,
    });
  }

  async listPaymentEvents(businessId: string, orderId: string): Promise<{
    fromState: string | null; toState: string; method: string | null; amountCents: number | null;
    reference: string | null; actorKind: string; note: string | null; createdAt: string;
  }[]> {
    const { rows } = await this.db.query<{
      from_state: string | null; to_state: string; method: string | null; amount_cents: string | null;
      reference: string | null; actor_kind: string; note: string | null; created_at: string;
    }>(
      'SELECT * FROM food_payment_events WHERE business_id = $1 AND order_id = $2 ORDER BY created_at ASC',
      [businessId, orderId],
    );
    return rows.map((row) => ({
      fromState: row.from_state, toState: row.to_state, method: row.method,
      amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
      reference: row.reference, actorKind: row.actor_kind, note: row.note, createdAt: row.created_at,
    }));
  }

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

  /**
   * Takes an order, or returns the one this exact customer action already
   * created.
   *
   * The payment state is decided HERE, from the business's setting at the
   * moment of ordering, and never re-derived later. An owner switching the
   * gate on halfway through service must not silently re-close orders the
   * kitchen has already started.
   */
  async createOrder(input: CreateFoodOrderInput): Promise<FoodOrderRecord> {
    // Checked before anything is written, and enforced again by a unique
    // index underneath - a check alone would still race two simultaneous
    // confirmations of the same order.
    if (input.idempotencyKey) {
      const existing = await this.findOrderByIdempotencyKey(input.businessId, input.idempotencyKey);
      if (existing) return existing;
    }

    const settings = await this.getSettings(input.businessId);

    if (input.fulfilmentMethod === 'DINE_IN' && !settings.tableServiceEnabled) {
      throw new TableServiceDisabledError('This business has not turned table service on.');
    }

    const terms = await this.findCustomerTerms(input.businessId, {
      contactId: input.customerContactId ?? null,
      phoneNumber: input.customerPhone ?? null,
    });

    // Standing terms mark the order WAIVED, never PAID. The money is still
    // owed, and the record an owner reconciles against must not claim
    // otherwise.
    const paymentState: FoodPaymentState = !settings.paymentRequiredBeforeKitchen
      ? 'NOT_REQUIRED'
      : terms?.allowPayOnDelivery
        ? 'WAIVED'
        : 'UNPAID';

    const orderNumber = await this.nextOrderNumber(input.businessId);
    const { rows } = await this.db.query<OrderRow>(
      `INSERT INTO food_orders
         (business_id, order_number, chat_id, customer_contact_id, fulfilment_method, customer_name, customer_phone,
          items, subtotal_cents, delivery_fee_cents, tax_cents, total_cents, currency,
          delivery_latitude, delivery_longitude, delivery_address, delivery_notes,
          allergen_notes, kitchen_notes, scheduled_for,
          payment_state, payment_waiver_kind, payment_waiver_reason, table_label, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING *`,
      [
        input.businessId, orderNumber, input.chatId ?? null, input.customerContactId ?? null, input.fulfilmentMethod,
        input.customerName ?? null, input.customerPhone ?? null, JSON.stringify(input.items),
        input.subtotalCents, input.deliveryFeeCents ?? 0, input.taxCents ?? 0, input.totalCents, input.currency ?? 'USD',
        input.deliveryLatitude ?? null, input.deliveryLongitude ?? null, input.deliveryAddress ?? null,
        input.deliveryNotes ?? null, input.allergenNotes ?? null, input.kitchenNotes ?? null, input.scheduledFor ?? null,
        paymentState,
        paymentState === 'WAIVED' ? 'customer_terms' : null,
        paymentState === 'WAIVED' ? (terms?.note ?? 'Standing pay-on-delivery terms') : null,
        input.tableLabel ?? null,
        input.idempotencyKey ?? null,
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
    actor: {
      userId?: string | null;
      kind?: FoodOrderEventRecord['actorKind'];
      note?: string | null;
      /**
       * A deliberate, attributable decision to cook an unpaid order - the
       * owner standing in front of a customer they know. Requires
       * food.approve at the route, and is written into the order's own
       * payment record as a waiver, never left only in a log.
       */
      overridePaymentGate?: { reason: string } | undefined;
    } = {},
  ): Promise<FoodOrderRecord | null> {
    const existing = await this.findOrder(businessId, id);
    if (!existing) return null;

    if (existing.stage === to) return existing;
    if (!canTransition(existing.stage, to)) {
      throw new IllegalStageTransitionError(`An order cannot move from ${existing.stage} to ${to}.`);
    }

    /**
     * THE PAYMENT GATE, and the only place it is applied.
     *
     * Only on the handover into the kitchen, because that is the move that
     * costs real money - everything after it is food that already exists.
     * An order that has been cooked must still be able to reach a counter
     * or a driver even if a refund has since been issued; stopping it
     * there would leave real food stranded on a pass.
     */
    if (to === 'IN_KITCHEN') {
      const settings = await this.getSettings(businessId);
      const release = releaseToKitchen({
        paymentState: existing.paymentState,
        paymentRequiredBeforeKitchen: settings.paymentRequiredBeforeKitchen,
        manualOverride: actor.overridePaymentGate ? { by: actor.userId ?? 'unknown', reason: actor.overridePaymentGate.reason } : undefined,
      });

      if (!release.released) {
        throw new KitchenPaymentGateError(release.reason, release.customerFacing);
      }

      // An override is recorded as a real waiver on the order, not merely
      // noted in an event: the next person to look at this order has to
      // see that it was released unpaid without reading a history.
      if (release.via === 'manual_override' && actor.overridePaymentGate) {
        await this.recordPayment(businessId, id, 'WAIVED', {
          actorUserId: actor.userId ?? null,
          actorKind: 'user',
          waiverReason: actor.overridePaymentGate.reason,
          note: 'Released to the kitchen without payment',
        });
      }
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
