import type { Queryable } from './types.js';
import type { FoodOrderStage, FulfilmentMethod } from '../domain/food/orderLifecycle.js';
import { canTransition, isOpenStage, OPEN_STAGES } from '../domain/food/orderLifecycle.js';
import type { FoodPaymentMethod, FoodPaymentState, KitchenRelease } from '../domain/food/paymentGate.js';
import { canTransitionPayment, releaseToKitchen } from '../domain/food/paymentGate.js';
import type { FoodNotificationEvent, NotificationOverrides, NotificationVerbosity } from '../services/food/orderNotifications.js';
import { raisedFindings, type QcFinding } from '../domain/food/qcFindings.js';
import { canTransitionAssignment, isFinalAssignmentState, whyNotAssignable, type DriverAssignmentState } from '../domain/food/driverAssignment.js';

export interface FoodMenuCategoryRecord {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface FoodModifierOptionRecord {
  id: string;
  groupId: string;
  name: string;
  priceDeltaCents: number;
  available: boolean;
  sortOrder: number;
}

export interface FoodModifierGroupRecord {
  id: string;
  name: string;
  /** How many of this group's options may be chosen. Null max means no limit. */
  minSelect: number;
  maxSelect: number | null;
  sortOrder: number;
  options: FoodModifierOptionRecord[];
}

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
  /** The category row, once one exists. The legacy `category` string is kept in step with it. */
  categoryId: string | null;
  sortOrder: number;
  /**
   * Shared modifier groups attached to this item, resolved. Empty for an
   * item that offers none, and for every item on a menu built before
   * groups existed - which is why the legacy `modifiers` JSONB above is
   * still honoured by the pricing resolver.
   */
  modifierGroups: FoodModifierGroupRecord[];
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
  /** Must a photo be taken before an order may leave the pass. */
  qcPhotoRequired: boolean;
  /** Is that photo actually read against the order. Genuinely separate from requiring one. */
  qcVisionEnabled: boolean;
  paymentRequiredNotice: string | null;
  slaWarningSeconds: number | null;
  slaBreachSeconds: number | null;
  /** How much this business tells its customers as an order moves. See services/food/orderNotifications.ts. */
  notificationVerbosity: NotificationVerbosity;
  /** Per-event switches and wording, only consulted under CUSTOM. */
  notificationOverrides: NotificationOverrides;
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

export interface FoodQcCheckRecord {
  id: string;
  orderId: string;
  photoReference: string | null;
  photoMimeType: string | null;
  observation: unknown;
  findings: QcFinding[];
  /** How many findings were actually put in front of a person - unverifiable ones are not. */
  raisedCount: number;
  provider: string | null;
  model: string | null;
  checkedBy: string | null;
  acknowledgedAt: string | null;
  acknowledgementNote: string | null;
  createdAt: string;
}

export interface FoodDriverRecord {
  id: string;
  name: string;
  phoneNumber: string | null;
  vehicle: string | null;
  notes: string | null;
  /**
   * Left rather than deleted. A driver who stops working here still drove
   * the deliveries they drove, and deleting them would rewrite that.
   */
  active: boolean;
  createdAt: string;
}

export interface FoodDeliveryRecord {
  id: string;
  orderId: string;
  driverId: string;
  /** Carried alongside the id so a board does not need a second lookup to say who has the food. */
  driverName: string;
  driverPhone: string | null;
  driverVehicle: string | null;
  state: DriverAssignmentState;
  assignedAt: string;
  assignedBy: string | null;
  collectedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  note: string | null;
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
  station: string | null; allergens: string[]; category_id: string | null; sort_order: number;
  created_at: string; updated_at: string;
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
    station: row.station, allergens: row.allergens ?? [],
    categoryId: row.category_id ?? null, sortOrder: row.sort_order ?? 0,
    // Filled in by listMenu, which loads every group in one pass rather
    // than a query per item.
    modifierGroups: [],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

interface QcCheckRow {
  id: string; order_id: string; photo_reference: string | null; photo_mime_type: string | null;
  observation: unknown; findings: QcFinding[] | null; raised_count: number;
  provider: string | null; model: string | null; checked_by: string | null;
  acknowledged_at: string | null; acknowledgement_note: string | null; created_at: string;
}

function toQcCheck(row: QcCheckRow): FoodQcCheckRecord {
  return {
    id: row.id, orderId: row.order_id, photoReference: row.photo_reference, photoMimeType: row.photo_mime_type,
    observation: row.observation ?? {}, findings: row.findings ?? [], raisedCount: Number(row.raised_count),
    provider: row.provider, model: row.model, checkedBy: row.checked_by,
    acknowledgedAt: row.acknowledged_at, acknowledgementNote: row.acknowledgement_note, createdAt: row.created_at,
  };
}

interface DriverRow {
  id: string; name: string; phone_number: string | null; vehicle: string | null;
  notes: string | null; active: boolean; created_at: string;
}

function toDriver(row: DriverRow): FoodDriverRecord {
  return {
    id: row.id, name: row.name, phoneNumber: row.phone_number, vehicle: row.vehicle,
    notes: row.notes, active: row.active, createdAt: row.created_at,
  };
}

interface DeliveryRow {
  id: string; order_id: string; driver_id: string; state: DriverAssignmentState;
  assigned_at: string; assigned_by: string | null; collected_at: string | null;
  finished_at: string | null; failure_reason: string | null; note: string | null;
  driver_name: string; driver_phone: string | null; driver_vehicle: string | null;
}

function toDelivery(row: DeliveryRow): FoodDeliveryRecord {
  return {
    id: row.id, orderId: row.order_id, driverId: row.driver_id, driverName: row.driver_name,
    driverPhone: row.driver_phone, driverVehicle: row.driver_vehicle, state: row.state,
    assignedAt: row.assigned_at, assignedBy: row.assigned_by, collectedAt: row.collected_at,
    finishedAt: row.finished_at, failureReason: row.failure_reason, note: row.note,
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

/** Naming a category that is not this business's. Its own type so a route can answer 404 rather than 500. */
export class UnknownMenuCategoryError extends Error {}

/**
 * Trying to send an order out of the pass without the photo this business
 * asked for. Its own type so the board can say what is wanted rather than
 * failing with something generic.
 */
export class QcPhotoRequiredError extends Error {}

/** Somebody else put a driver on this order first. Normal during a rush, not an application bug. */
export class OrderAlreadyAssignedError extends Error {}

/** A driver on an order nobody is driving anywhere - a collection, a table, a finished order. */
export class OrderNotDeliverableError extends Error {}

export class IllegalAssignmentTransitionError extends Error {}

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
      notification_verbosity: NotificationVerbosity; notification_overrides: NotificationOverrides;
      qc_photo_required: boolean; qc_vision_enabled: boolean;
    }>('SELECT * FROM food_settings WHERE business_id = $1', [businessId]);

    const row = rows[0];
    return {
      businessId,
      // Defaults chosen to protect a business that has not thought about
      // this yet: wait for money, and do not show a table field.
      paymentRequiredBeforeKitchen: row?.payment_required_before_kitchen ?? true,
      tableServiceEnabled: row?.table_service_enabled ?? false,
      // Both off: this is help a business opts into, not a step imposed
      // on a kitchen that never asked for one - and a kitchen made to
      // photograph every order will find a way not to.
      qcPhotoRequired: row?.qc_photo_required ?? false,
      qcVisionEnabled: row?.qc_vision_enabled ?? false,
      paymentRequiredNotice: row?.payment_required_notice ?? null,
      slaWarningSeconds: row?.sla_warning_seconds ?? null,
      slaBreachSeconds: row?.sla_breach_seconds ?? null,
      // STANDARD by default: the milestones a customer genuinely wants,
      // and none of the ones that only produce noise.
      notificationVerbosity: row?.notification_verbosity ?? 'STANDARD',
      notificationOverrides: row?.notification_overrides ?? {},
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
         (business_id, payment_required_before_kitchen, table_service_enabled, payment_required_notice,
          sla_warning_seconds, sla_breach_seconds, notification_verbosity, notification_overrides, updated_by,
          qc_photo_required, qc_vision_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (business_id) DO UPDATE
         SET payment_required_before_kitchen = EXCLUDED.payment_required_before_kitchen,
             table_service_enabled = EXCLUDED.table_service_enabled,
             payment_required_notice = EXCLUDED.payment_required_notice,
             sla_warning_seconds = EXCLUDED.sla_warning_seconds,
             sla_breach_seconds = EXCLUDED.sla_breach_seconds,
             notification_verbosity = EXCLUDED.notification_verbosity,
             notification_overrides = EXCLUDED.notification_overrides,
             updated_by = EXCLUDED.updated_by,
             qc_photo_required = EXCLUDED.qc_photo_required,
             qc_vision_enabled = EXCLUDED.qc_vision_enabled,
             updated_at = now()`,
      [
        businessId, next.paymentRequiredBeforeKitchen, next.tableServiceEnabled, next.paymentRequiredNotice,
        next.slaWarningSeconds, next.slaBreachSeconds, next.notificationVerbosity,
        JSON.stringify(next.notificationOverrides), updatedBy,
        next.qcPhotoRequired, next.qcVisionEnabled,
      ],
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

  /**
   * The whole menu, with every item's shared modifier groups attached.
   *
   * Three queries rather than one per item: a menu of forty items with
   * five groups each would otherwise be two hundred round trips on a path
   * that runs for every AI reply.
   *
   * Ordered the way the operator arranged it - category order first, then
   * position within it - because a menu read back to a customer in
   * alphabetical order is not the menu they wrote.
   */
  async listMenu(businessId: string, options: { availableOnly?: boolean } = {}): Promise<FoodMenuItemRecord[]> {
    const { rows } = await this.db.query<MenuItemRow & { category_sort: number | null }>(
      `SELECT item.*, category.sort_order AS category_sort
       FROM food_menu_items item
       LEFT JOIN food_menu_categories category
         ON category.business_id = item.business_id AND category.id = item.category_id
       WHERE item.business_id = $1 AND ($2::boolean IS NOT TRUE OR item.available = true)
       ORDER BY COALESCE(category.sort_order, 0), item.category, item.sort_order, item.name`,
      [businessId, options.availableOnly ?? false],
    );

    const items = rows.map(toMenuItem);
    if (items.length === 0) return items;

    const groups = await this.loadModifierGroups(businessId, options.availableOnly ?? false);
    const attachments = await this.db.query<{ menu_item_id: string; group_id: string; sort_order: number }>(
      'SELECT * FROM food_menu_item_modifier_groups WHERE business_id = $1 ORDER BY sort_order',
      [businessId],
    );

    const byId = new Map(items.map((item) => [item.id, item]));
    for (const attachment of attachments.rows) {
      const group = groups.get(attachment.group_id);
      const item = byId.get(attachment.menu_item_id);
      if (group && item) item.modifierGroups.push(group);
    }

    return items;
  }

  /** Every modifier group with its options, keyed by id. Shared by listMenu and the menu editor. */
  private async loadModifierGroups(businessId: string, availableOnly: boolean): Promise<Map<string, FoodModifierGroupRecord>> {
    const [groupRows, optionRows] = await Promise.all([
      this.db.query<{ id: string; name: string; min_select: number; max_select: number | null; sort_order: number }>(
        'SELECT * FROM food_modifier_groups WHERE business_id = $1 ORDER BY sort_order, name',
        [businessId],
      ),
      this.db.query<{ id: string; group_id: string; name: string; price_delta_cents: string; available: boolean; sort_order: number }>(
        `SELECT * FROM food_modifier_options
         WHERE business_id = $1 AND ($2::boolean IS NOT TRUE OR available = true)
         ORDER BY sort_order, name`,
        [businessId, availableOnly],
      ),
    ]);

    const groups = new Map<string, FoodModifierGroupRecord>(
      groupRows.rows.map((row) => [
        row.id,
        { id: row.id, name: row.name, minSelect: row.min_select, maxSelect: row.max_select, sortOrder: row.sort_order, options: [] },
      ]),
    );

    for (const option of optionRows.rows) {
      groups.get(option.group_id)?.options.push({
        id: option.id,
        groupId: option.group_id,
        name: option.name,
        priceDeltaCents: Number(option.price_delta_cents),
        available: option.available,
        sortOrder: option.sort_order,
      });
    }

    return groups;
  }

  // ── Categories ─────────────────────────────────────────────────────────

  async listCategories(businessId: string): Promise<FoodMenuCategoryRecord[]> {
    const { rows } = await this.db.query<{ id: string; name: string; sort_order: number; active: boolean }>(
      'SELECT * FROM food_menu_categories WHERE business_id = $1 ORDER BY sort_order, name',
      [businessId],
    );
    return rows.map((row) => ({ id: row.id, name: row.name, sortOrder: row.sort_order, active: row.active }));
  }

  /**
   * Adds a category, or returns the one that already carries this name.
   *
   * Case-insensitive, because "Mains" and "mains" are one section of one
   * menu and an operator who types the second should not end up with two.
   */
  async createCategory(businessId: string, name: string, sortOrder?: number): Promise<FoodMenuCategoryRecord> {
    const { rows } = await this.db.query<{ id: string; name: string; sort_order: number; active: boolean }>(
      `INSERT INTO food_menu_categories (business_id, name, sort_order)
       VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM food_menu_categories WHERE business_id = $1)))
       ON CONFLICT (business_id, lower(name)) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [businessId, name.trim(), sortOrder ?? null],
    );
    const row = rows[0]!;
    return { id: row.id, name: row.name, sortOrder: row.sort_order, active: row.active };
  }

  /**
   * Renames a section, and rewrites the legacy `category` text on its items
   * in the same breath.
   *
   * Renaming without that second write is exactly the orphaning this table
   * was added to prevent - the section would read "Mains" and every item
   * in it would still carry the typo.
   */
  async renameCategory(businessId: string, id: string, name: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE food_menu_categories SET name = $3, updated_at = now() WHERE business_id = $1 AND id = $2',
      [businessId, id, name.trim()],
    );
    if ((rowCount ?? 0) === 0) return false;

    await this.db.query(
      'UPDATE food_menu_items SET category = $3, updated_at = now() WHERE business_id = $1 AND category_id = $2',
      [businessId, id, name.trim()],
    );
    return true;
  }

  /** Reorders in one statement, so a drag on the menu screen is one round trip and cannot half-apply. */
  async reorderCategories(businessId: string, orderedIds: string[]): Promise<void> {
    if (orderedIds.length === 0) return;
    await this.db.query(
      `UPDATE food_menu_categories SET sort_order = position.ordinality * 10, updated_at = now()
       FROM unnest($2::uuid[]) WITH ORDINALITY AS position(id, ordinality)
       WHERE food_menu_categories.business_id = $1 AND food_menu_categories.id = position.id`,
      [businessId, orderedIds],
    );
  }

  /**
   * Deletes a category. Its items survive, uncategorised - the FK is ON
   * DELETE SET NULL on purpose, because removing a menu section must never
   * silently delete the food in it.
   */
  async deleteCategory(businessId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM food_menu_categories WHERE business_id = $1 AND id = $2', [businessId, id]);
    return (rowCount ?? 0) > 0;
  }

  // ── Modifier groups ────────────────────────────────────────────────────

  async listModifierGroups(businessId: string): Promise<FoodModifierGroupRecord[]> {
    const groups = await this.loadModifierGroups(businessId, false);
    return [...groups.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async createModifierGroup(
    businessId: string,
    input: { name: string; minSelect?: number; maxSelect?: number | null },
  ): Promise<FoodModifierGroupRecord> {
    const { rows } = await this.db.query<{ id: string; name: string; min_select: number; max_select: number | null; sort_order: number }>(
      `INSERT INTO food_modifier_groups (business_id, name, min_select, max_select, sort_order)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM food_modifier_groups WHERE business_id = $1))
       RETURNING *`,
      [businessId, input.name.trim(), input.minSelect ?? 0, input.maxSelect ?? null],
    );
    const row = rows[0]!;
    return { id: row.id, name: row.name, minSelect: row.min_select, maxSelect: row.max_select, sortOrder: row.sort_order, options: [] };
  }

  async addModifierOption(
    businessId: string,
    groupId: string,
    input: { name: string; priceDeltaCents?: number },
  ): Promise<FoodModifierOptionRecord | null> {
    const { rows } = await this.db.query<{ id: string; group_id: string; name: string; price_delta_cents: string; available: boolean; sort_order: number }>(
      `INSERT INTO food_modifier_options (business_id, group_id, name, price_delta_cents, sort_order)
       SELECT $1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM food_modifier_options WHERE business_id = $1 AND group_id = $2)
       WHERE EXISTS (SELECT 1 FROM food_modifier_groups WHERE business_id = $1 AND id = $2)
       RETURNING *`,
      [businessId, groupId, input.name.trim(), input.priceDeltaCents ?? 0],
    );
    const row = rows[0];
    return row
      ? { id: row.id, groupId: row.group_id, name: row.name, priceDeltaCents: Number(row.price_delta_cents), available: row.available, sortOrder: row.sort_order }
      : null;
  }

  /** The same one-tap out-of-stock an item has. A kitchen runs out of bacon, not just of burgers. */
  async setModifierOptionAvailability(businessId: string, optionId: string, available: boolean): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE food_modifier_options SET available = $3, updated_at = now() WHERE business_id = $1 AND id = $2',
      [businessId, optionId, available],
    );
    return (rowCount ?? 0) > 0;
  }

  async deleteModifierGroup(businessId: string, groupId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM food_modifier_groups WHERE business_id = $1 AND id = $2', [businessId, groupId]);
    return (rowCount ?? 0) > 0;
  }

  /** Attaches a shared group to an item - the whole point of groups being shared. Idempotent. */
  async attachModifierGroup(businessId: string, menuItemId: string, groupId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO food_menu_item_modifier_groups (business_id, menu_item_id, group_id, sort_order)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM food_menu_item_modifier_groups WHERE business_id = $1 AND menu_item_id = $2))
       ON CONFLICT (business_id, menu_item_id, group_id) DO NOTHING`,
      [businessId, menuItemId, groupId],
    );
  }

  async detachModifierGroup(businessId: string, menuItemId: string, groupId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM food_menu_item_modifier_groups WHERE business_id = $1 AND menu_item_id = $2 AND group_id = $3',
      [businessId, menuItemId, groupId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Edits an item in place. Only fields the caller sent are touched, so a
   * partial save cannot blank a price.
   *
   * Moving an item between categories rewrites the legacy `category` text
   * from the category row in the same statement. The two columns describe
   * one fact, and a menu where they disagree sorts one way and reads back
   * another - so they are never allowed to drift apart, not even between
   * two writes.
   */
  async updateMenuItem(
    businessId: string,
    id: string,
    patch: { name?: string; priceCents?: number; description?: string | null; categoryId?: string | null; sortOrder?: number; aliases?: string[]; station?: string | null; allergens?: string[]; variants?: unknown[] },
  ): Promise<FoodMenuItemRecord | null> {
    const { rows } = await this.db.query<MenuItemRow>(
      `UPDATE food_menu_items SET
         name = COALESCE($3, name),
         price_cents = COALESCE($4, price_cents),
         description = COALESCE($5, description),
         category_id = COALESCE($6, category_id),
         category = COALESCE(
           (SELECT name FROM food_menu_categories WHERE business_id = $1 AND id = COALESCE($6, category_id)),
           category
         ),
         aliases = COALESCE($7, aliases),
         station = COALESCE($8, station),
         allergens = COALESCE($9, allergens),
         variants = COALESCE($10, variants),
         sort_order = COALESCE($11, sort_order),
         updated_at = now()
       WHERE business_id = $1 AND id = $2
       RETURNING *`,
      [
        businessId, id, patch.name ?? null, patch.priceCents ?? null, patch.description ?? null,
        patch.categoryId ?? null, patch.aliases ?? null, patch.station ?? null, patch.allergens ?? null,
        patch.variants ? JSON.stringify(patch.variants) : null, patch.sortOrder ?? null,
      ],
    );
    return rows[0] ? toMenuItem(rows[0]) : null;
  }

  /**
   * Reorders items within a category in one statement, for the same reason
   * categories reorder in one: a drag that half-applies leaves a menu in a
   * state the operator did not ask for and cannot see.
   */
  async reorderMenuItems(businessId: string, orderedIds: string[]): Promise<void> {
    if (orderedIds.length === 0) return;
    await this.db.query(
      `UPDATE food_menu_items SET sort_order = position.ordinality * 10, updated_at = now()
       FROM unnest($2::uuid[]) WITH ORDINALITY AS position(id, ordinality)
       WHERE food_menu_items.business_id = $1 AND food_menu_items.id = position.id`,
      [businessId, orderedIds],
    );
  }

  async deleteMenuItem(businessId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM food_menu_items WHERE business_id = $1 AND id = $2', [businessId, id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Adds an item.
   *
   * A caller may name the category either way - by row id from the menu
   * editor, or by the plain string the API has always taken. Whichever
   * arrives, both columns are written together: a new item created through
   * the old shape still lands in the right section of the new menu instead
   * of quietly falling out of it.
   */
  async createMenuItem(input: {
    businessId: string; name: string; priceCents: number; category?: string; categoryId?: string | null; sku?: string | null;
    description?: string | null; currency?: string; aliases?: string[]; variants?: unknown[]; modifiers?: unknown[];
    station?: string | null; allergens?: string[];
  }): Promise<FoodMenuItemRecord> {
    // Resolving the category BEFORE the insert, rather than in a subquery,
    // so a name that has no row yet gets one - otherwise every item typed
    // into a section the operator has not formally created would sort
    // itself to the top of the menu under a null category.
    let categoryId = input.categoryId ?? null;
    // 'GENERAL' is the uncategorised section and gets a real row like any
    // other, so an item added without a category still sorts predictably
    // instead of floating above the menu on a null.
    let categoryName = input.category?.trim() || (categoryId ? null : 'GENERAL');
    if (!categoryId && categoryName) {
      const category = await this.createCategory(input.businessId, categoryName);
      categoryId = category.id;
      categoryName = category.name;
    } else if (categoryId) {
      const { rows } = await this.db.query<{ name: string }>(
        'SELECT name FROM food_menu_categories WHERE business_id = $1 AND id = $2',
        [input.businessId, categoryId],
      );
      if (!rows[0]) throw new UnknownMenuCategoryError('That menu category does not exist.');
      categoryName = rows[0].name;
    }

    const { rows } = await this.db.query<MenuItemRow>(
      `INSERT INTO food_menu_items
         (business_id, name, sku, category, category_id, description, price_cents, currency, aliases, variants, modifiers, station, allergens, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM food_menu_items WHERE business_id = $1 AND category_id IS NOT DISTINCT FROM $5))
       RETURNING *`,
      [
        input.businessId, input.name, input.sku ?? null, categoryName ?? 'GENERAL', categoryId, input.description ?? null,
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
      /**
       * Sending an order out without the photo this business asked for -
       * a broken camera, a queue out of the door. A reason is required
       * because an escape hatch nobody has to account for stops being an
       * escape hatch and becomes the normal route.
       */
      overrideQcPhoto?: { reason: string } | undefined;
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

    /**
     * THE QUALITY CHECK GATE.
     *
     * Only on the way OUT of the pass, because that is the last moment
     * anybody can look in the bag. Never on the way in - a ticket must
     * always be able to reach the pass, or the board backs up behind a
     * camera.
     *
     * Nothing here is about what the photo SHOWED. A warning is for a
     * person to weigh; only the absence of a photo this business asked
     * for stops anything.
     */
    if (existing.stage === 'QUALITY_CHECK' && (to === 'READY_FOR_PICKUP' || to === 'OUT_FOR_DELIVERY')) {
      const settings = await this.getSettings(businessId);
      if (settings.qcPhotoRequired && !actor.overrideQcPhoto && !(await this.hasQcCheck(businessId, id))) {
        throw new QcPhotoRequiredError('This order needs a photo before it leaves the pass.');
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
      // Appended rather than replacing the operator's own note: both are
      // things somebody chose to say about this move.
      note: actor.overrideQcPhoto
        ? [actor.note, `Sent out without a photo: ${actor.overrideQcPhoto.reason}`].filter(Boolean).join(' — ')
        : actor.note ?? null,
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

  // ── Customer notifications ─────────────────────────────────────────────

  /**
   * Claims the right to tell a customer about one event, exactly once.
   *
   * Returns false when this order has already been told, which is the
   * normal case rather than an error: a kitchen sends a ticket back to the
   * line and bumps it again all the time, and the customer must not hear
   * that cooking has started twice.
   *
   * The insert IS the lock. Checking first and then sending would still
   * race two workers bumping the same ticket, and the unique index is the
   * only thing that cannot.
   */
  async claimNotification(businessId: string, orderId: string, event: FoodNotificationEvent, body: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO food_order_notifications (business_id, order_id, event, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, order_id, event) DO NOTHING`,
      [businessId, orderId, event, body],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Records which outbound message a claimed notification became. Best-effort: a null here means the send failed, and the attempt is still on record. */
  async attachNotificationOutbound(businessId: string, orderId: string, event: FoodNotificationEvent, outboundMessageId: string): Promise<void> {
    await this.db.query(
      `UPDATE food_order_notifications SET outbound_message_id = $4
       WHERE business_id = $1 AND order_id = $2 AND event = $3`,
      [businessId, orderId, event, outboundMessageId],
    );
  }

  /** What this customer has already been told, and when - the answer when somebody says they heard nothing. */
  async listNotifications(businessId: string, orderId: string): Promise<{ event: string; body: string; outboundMessageId: string | null; createdAt: string }[]> {
    const { rows } = await this.db.query<{ event: string; body: string; outbound_message_id: string | null; created_at: string }>(
      'SELECT * FROM food_order_notifications WHERE business_id = $1 AND order_id = $2 ORDER BY created_at ASC',
      [businessId, orderId],
    );
    return rows.map((row) => ({ event: row.event, body: row.body, outboundMessageId: row.outbound_message_id, createdAt: row.created_at }));
  }

  // ── Delivery zones ─────────────────────────────────────────────────────

  // ── Quality check ──────────────────────────────────────────────────────

  /**
   * Stores what a photo showed.
   *
   * Every finding is kept, unverifiable ones included, so the check has an
   * honest account of itself - the SCREEN filters those out, the record
   * does not. raisedCount is denormalised alongside because "which orders
   * were flagged" should be an index lookup, not a scan through JSONB.
   */
  async recordQcCheck(input: {
    businessId: string;
    orderId: string;
    observation: unknown;
    findings: QcFinding[];
    photoReference?: string | null;
    photoSha256?: string | null;
    photoMimeType?: string | null;
    provider?: string | null;
    model?: string | null;
    checkedBy?: string | null;
  }): Promise<FoodQcCheckRecord> {
    const { rows } = await this.db.query<QcCheckRow>(
      `INSERT INTO food_qc_checks
         (business_id, order_id, photo_reference, photo_sha256, photo_mime_type,
          observation, findings, raised_count, provider, model, checked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.businessId, input.orderId, input.photoReference ?? null, input.photoSha256 ?? null,
        input.photoMimeType ?? null, JSON.stringify(input.observation ?? {}), JSON.stringify(input.findings),
        raisedFindings(input.findings).length, input.provider ?? null, input.model ?? null, input.checkedBy ?? null,
      ],
    );
    return toQcCheck(rows[0]!);
  }

  /**
   * The most recent check for each of these orders, in one query.
   *
   * The board needs this for every ticket at the pass at once; a query per
   * card would put the kitchen screen's poll into double figures of round
   * trips every five seconds.
   */
  async latestQcCheckByOrder(businessId: string, orderIds: string[]): Promise<Map<string, FoodQcCheckRecord>> {
    if (orderIds.length === 0) return new Map();
    const { rows } = await this.db.query<QcCheckRow>(
      `SELECT DISTINCT ON (order_id) *
       FROM food_qc_checks
       WHERE business_id = $1 AND order_id = ANY($2::uuid[])
       ORDER BY order_id, created_at DESC`,
      [businessId, orderIds],
    );
    return new Map(rows.map((row) => [row.order_id, toQcCheck(row)]));
  }

  async listQcChecks(businessId: string, orderId: string): Promise<FoodQcCheckRecord[]> {
    const { rows } = await this.db.query<QcCheckRow>(
      'SELECT * FROM food_qc_checks WHERE business_id = $1 AND order_id = $2 ORDER BY created_at DESC',
      [businessId, orderId],
    );
    return rows.map(toQcCheck);
  }

  /** Has this order been photographed at all. What the gate below turns on. */
  async hasQcCheck(businessId: string, orderId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM food_qc_checks WHERE business_id = $1 AND order_id = $2) AS exists',
      [businessId, orderId],
    );
    return rows[0]?.exists ?? false;
  }

  /**
   * Somebody looked at a warning and decided.
   *
   * Recorded because a finding nobody acted on and a finding somebody
   * looked at and dismissed are different facts, and only one of them is a
   * problem with the kitchen.
   */
  async acknowledgeQcCheck(businessId: string, id: string, by: string | null, note: string | null): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE food_qc_checks SET acknowledged_at = now(), acknowledged_by = $3, acknowledgement_note = $4
       WHERE business_id = $1 AND id = $2 AND acknowledged_at IS NULL`,
      [businessId, id, by, note],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── Drivers ────────────────────────────────────────────────────────────

  async listDrivers(businessId: string, options: { activeOnly?: boolean } = {}): Promise<FoodDriverRecord[]> {
    const { rows } = await this.db.query<DriverRow>(
      `SELECT * FROM food_drivers
       WHERE business_id = $1 AND ($2::boolean IS NOT TRUE OR active = true)
       ORDER BY active DESC, name`,
      [businessId, options.activeOnly ?? false],
    );
    return rows.map(toDriver);
  }

  async createDriver(input: {
    businessId: string; name: string; phoneNumber?: string | null; vehicle?: string | null; notes?: string | null;
  }): Promise<FoodDriverRecord> {
    const { rows } = await this.db.query<DriverRow>(
      `INSERT INTO food_drivers (business_id, name, phone_number, vehicle, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.businessId, input.name.trim(), input.phoneNumber ?? null, input.vehicle ?? null, input.notes ?? null],
    );
    return toDriver(rows[0]!);
  }

  async updateDriver(
    businessId: string,
    id: string,
    patch: { name?: string; phoneNumber?: string | null; vehicle?: string | null; notes?: string | null },
  ): Promise<FoodDriverRecord | null> {
    const { rows } = await this.db.query<DriverRow>(
      `UPDATE food_drivers SET
         name = COALESCE($3, name),
         phone_number = COALESCE($4, phone_number),
         vehicle = COALESCE($5, vehicle),
         notes = COALESCE($6, notes),
         updated_at = now()
       WHERE business_id = $1 AND id = $2 RETURNING *`,
      [businessId, id, patch.name ?? null, patch.phoneNumber ?? null, patch.vehicle ?? null, patch.notes ?? null],
    );
    return rows[0] ? toDriver(rows[0]) : null;
  }

  /**
   * A driver who has stopped working here.
   *
   * There is deliberately no delete. Their deliveries are a record of what
   * happened, and the schema's ON DELETE RESTRICT makes this the only
   * route rather than merely the recommended one.
   */
  async setDriverActive(businessId: string, id: string, active: boolean): Promise<FoodDriverRecord | null> {
    const { rows } = await this.db.query<DriverRow>(
      'UPDATE food_drivers SET active = $3, updated_at = now() WHERE business_id = $1 AND id = $2 RETURNING *',
      [businessId, id, active],
    );
    return rows[0] ? toDriver(rows[0]) : null;
  }

  // ── Deliveries ─────────────────────────────────────────────────────────

  private static readonly DELIVERY_SELECT = `
    SELECT delivery.*, driver.name AS driver_name, driver.phone_number AS driver_phone, driver.vehicle AS driver_vehicle
    FROM food_order_deliveries delivery
    JOIN food_drivers driver ON driver.business_id = delivery.business_id AND driver.id = delivery.driver_id`;

  /**
   * Puts a driver on an order.
   *
   * The one-live-assignment rule is enforced by a unique partial index
   * rather than by reading first and then writing: two people assigning
   * two drivers in the same moment is exactly what happens during a rush,
   * and the second one has to lose in the database.
   */
  async assignDriver(
    businessId: string,
    orderId: string,
    driverId: string,
    actor: { userId?: string | null; note?: string | null } = {},
  ): Promise<FoodDeliveryRecord | null> {
    const order = await this.findOrder(businessId, orderId);
    if (!order) return null;

    const refusal = whyNotAssignable(order);
    if (refusal) throw new OrderNotDeliverableError(refusal);

    try {
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO food_order_deliveries (business_id, order_id, driver_id, assigned_by, note)
         SELECT $1, $2, $3, $4, $5
         WHERE EXISTS (SELECT 1 FROM food_drivers WHERE business_id = $1 AND id = $3 AND active = true)
         RETURNING id`,
        [businessId, orderId, driverId, actor.userId ?? null, actor.note ?? null],
      );
      const id = rows[0]?.id;
      // No row means the driver is not this business's, or is no longer
      // working here - which from the caller's side is "not found".
      if (!id) return null;
      return await this.findDelivery(businessId, id);
    } catch (error) {
      // 23505: the live-assignment index. Somebody got there first.
      if ((error as { code?: string }).code === '23505') {
        throw new OrderAlreadyAssignedError('Somebody has already put a driver on this order.');
      }
      throw error;
    }
  }

  async findDelivery(businessId: string, id: string): Promise<FoodDeliveryRecord | null> {
    const { rows } = await this.db.query<DeliveryRow>(
      `${FoodOperationsRepository.DELIVERY_SELECT} WHERE delivery.business_id = $1 AND delivery.id = $2`,
      [businessId, id],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  /** The assignment that is actually live on this order, if any. */
  async findLiveDelivery(businessId: string, orderId: string): Promise<FoodDeliveryRecord | null> {
    const { rows } = await this.db.query<DeliveryRow>(
      `${FoodOperationsRepository.DELIVERY_SELECT}
       WHERE delivery.business_id = $1 AND delivery.order_id = $2
         AND delivery.state IN ('ASSIGNED', 'COLLECTED', 'FAILED')`,
      [businessId, orderId],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  /**
   * The live assignment for each of these orders, in one query - the board
   * needs it for every ticket at once, and a query per card would put a
   * kitchen screen's five-second poll into double figures of round trips.
   */
  async liveDeliveriesByOrder(businessId: string, orderIds: string[]): Promise<Map<string, FoodDeliveryRecord>> {
    if (orderIds.length === 0) return new Map();
    const { rows } = await this.db.query<DeliveryRow>(
      `${FoodOperationsRepository.DELIVERY_SELECT}
       WHERE delivery.business_id = $1 AND delivery.order_id = ANY($2::uuid[])
         AND delivery.state IN ('ASSIGNED', 'COLLECTED', 'FAILED')`,
      [businessId, orderIds],
    );
    return new Map(rows.map((row) => [row.order_id, toDelivery(row)]));
  }

  /** What this driver has carried. The question asked of a name rather than of an order. */
  async listDriverRuns(businessId: string, driverId: string, limit = 50): Promise<FoodDeliveryRecord[]> {
    const { rows } = await this.db.query<DeliveryRow>(
      `${FoodOperationsRepository.DELIVERY_SELECT}
       WHERE delivery.business_id = $1 AND delivery.driver_id = $2
       ORDER BY delivery.created_at DESC LIMIT $3`,
      [businessId, driverId, limit],
    );
    return rows.map(toDelivery);
  }

  /**
   * Moves an assignment along.
   *
   * A failure needs a reason, because "failed" on its own tells the next
   * person nothing they can act on - and the next person is usually
   * standing in a shop holding food that has come back.
   */
  async moveDelivery(
    businessId: string,
    id: string,
    to: DriverAssignmentState,
    actor: { failureReason?: string | null; note?: string | null } = {},
  ): Promise<FoodDeliveryRecord | null> {
    const existing = await this.findDelivery(businessId, id);
    if (!existing) return null;
    if (existing.state === to) return existing;

    if (!canTransitionAssignment(existing.state, to)) {
      throw new IllegalAssignmentTransitionError(`A delivery cannot go from ${existing.state} to ${to}.`);
    }
    if (to === 'FAILED' && !actor.failureReason?.trim()) {
      throw new IllegalAssignmentTransitionError('Say what went wrong - a failed delivery with no reason helps nobody.');
    }

    const { rows } = await this.db.query<DeliveryRow>(
      `WITH updated AS (
         UPDATE food_order_deliveries SET
           state = $3,
           collected_at = CASE WHEN $3 = 'COLLECTED' THEN COALESCE(collected_at, now()) ELSE collected_at END,
           finished_at = CASE WHEN $4::boolean THEN COALESCE(finished_at, now()) ELSE finished_at END,
           failure_reason = COALESCE($5, failure_reason),
           note = COALESCE($6, note),
           updated_at = now()
         WHERE business_id = $1 AND id = $2
         RETURNING *
       )
       SELECT updated.*, driver.name AS driver_name, driver.phone_number AS driver_phone, driver.vehicle AS driver_vehicle
       FROM updated JOIN food_drivers driver ON driver.business_id = updated.business_id AND driver.id = updated.driver_id`,
      [businessId, id, to, isFinalAssignmentState(to), actor.failureReason ?? null, actor.note ?? null],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

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
