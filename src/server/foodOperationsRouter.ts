import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { FoodOperationsRepository, IllegalPaymentTransitionError, IllegalStageTransitionError, KitchenPaymentGateError, UnknownMenuCategoryError } from '../repositories/foodOperationsRepository.js';
import { FOOD_PAYMENT_STATES } from '../domain/food/paymentGate.js';
import { FOOD_ORDER_STAGES, bumpTarget, elapsedSeconds, slaBand } from '../domain/food/orderLifecycle.js';
import { checkDelivery, navigationUrl } from '../domain/food/deliveryZone.js';
import { releaseToKitchen } from '../domain/food/paymentGate.js';
import { confirmProposal, resolveProposal, type DraftOrderProposal } from '../services/food/orderIntake.js';
import { eventForStage } from '../services/food/orderNotifications.js';
import { sendOrderNotification } from '../services/food/sendOrderNotification.js';
import { requireAuth, requirePermission, requireProductAccess, type AuthContext } from './authMiddleware.js';
import { hasPermission } from '../domain/auth/permissions.js';

const router = Router();
const repository = new FoodOperationsRepository(pool);

router.use(requireAuth);
router.use(requireProductAccess('food'));

const uuid = z.string().uuid();

/**
 * The board, with the clock already worked out.
 *
 * The elapsed time and its colour band are computed here rather than in the
 * browser so every screen in the kitchen agrees - two tablets disagreeing
 * about whether a ticket is late is worse than neither showing a timer. The
 * browser still ticks the seconds between polls; it just never decides the
 * band itself.
 */
router.get('/board', requirePermission('food.view'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  const orders = await repository.listBoard(auth.businessId);
  const settings = await repository.getSettings(auth.businessId);
  const now = new Date();

  return res.status(200).json({
    serverTime: now.toISOString(),
    settings,
    orders: orders.map((order) => {
      const elapsed = elapsedSeconds(order, now);
      const next = bumpTarget(order.stage, order.fulfilmentMethod);
      // Worked out here so the board can show WHY a ticket cannot start
      // rather than offering a button that will be refused. A bump that
      // silently does nothing is the worst behaviour on a screen somebody
      // is working at speed.
      const gate =
        next === 'IN_KITCHEN'
          ? releaseToKitchen({ paymentState: order.paymentState, paymentRequiredBeforeKitchen: settings.paymentRequiredBeforeKitchen })
          : null;
      return {
        ...order,
        elapsedSeconds: elapsed,
        slaBand: slaBand(elapsed, {
          ...(settings.slaWarningSeconds !== null ? { warningSeconds: settings.slaWarningSeconds } : {}),
          ...(settings.slaBreachSeconds !== null ? { breachSeconds: settings.slaBreachSeconds } : {}),
        }),
        nextStage: next,
        blockedReason: gate && !gate.released ? gate.reason : null,
        navigationUrl:
          order.fulfilmentMethod === 'DELIVERY' && order.deliveryLatitude !== null && order.deliveryLongitude !== null
            ? navigationUrl({ latitude: order.deliveryLatitude, longitude: order.deliveryLongitude })
            : null,
      };
    }),
  });
});

router.get('/orders/:orderId', requirePermission('food.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const orderId = String(req.params.orderId ?? '');
  if (!uuid.safeParse(orderId).success) return res.status(400).json({ error: 'INVALID_ORDER_ID' });

  const order = await repository.findOrder(auth.businessId, orderId);
  if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });

  return res.status(200).json({ order, events: await repository.listEvents(auth.businessId, orderId) });
});

const stageSchema = z.object({
  stage: z.enum(FOOD_ORDER_STAGES),
  note: z.string().trim().max(500).optional(),
  /**
   * Cooking an unpaid order on purpose. A reason is required, not
   * optional: an unattributable exemption is indistinguishable from a
   * mistake, and this one gives away food.
   */
  overridePaymentReason: z.string().trim().min(3).max(500).optional(),
});

/**
 * Moving a ticket. One route for every station, because a bump is the same
 * gesture wherever it is pressed.
 *
 * An illegal move is a 409 rather than a 400: the request is well-formed
 * and the caller is entitled to make it, the ORDER is simply no longer
 * where the caller thought it was - usually because somebody at another
 * station bumped it first, which during a rush is normal rather than
 * exceptional.
 */
router.post('/orders/:orderId/stage', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const orderId = String(req.params.orderId ?? '');
  if (!uuid.safeParse(orderId).success) return res.status(400).json({ error: 'INVALID_ORDER_ID' });

  const parsed = stageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_STAGE', details: parsed.error.flatten() });

  // Overriding the payment gate is a commercial decision about giving away
  // food, so it needs more than the permission that moves a ticket.
  if (parsed.data.overridePaymentReason && !hasPermission(auth.role, 'food.approve')) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Releasing an unpaid order to the kitchen needs food.approve.' });
  }

  try {
    const order = await repository.moveToStage(auth.businessId, orderId, parsed.data.stage, {
      userId: auth.userId,
      kind: 'user',
      note: parsed.data.note ?? null,
      ...(parsed.data.overridePaymentReason ? { overridePaymentGate: { reason: parsed.data.overridePaymentReason } } : {}),
    });
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });

    // Awaited, so the response can honestly report whether the customer
    // was told - but it can never fail the move: the ticket has already
    // been bumped, and a notification problem must not make a cook think
    // their press did not register.
    const event = eventForStage(order.stage);
    const notified = event ? await sendOrderNotification(order, event) : null;

    return res.status(200).json({ order, ...(notified ? { notified } : {}) });
  } catch (error) {
    // 402: the request is legitimate and the order is real - it simply has
    // not been paid for. customerFacing is returned so the operator can
    // tell the person waiting, in a sentence already written for them.
    if (error instanceof KitchenPaymentGateError) {
      return res.status(402).json({ error: 'PAYMENT_REQUIRED', message: error.message, customerFacing: error.customerFacing });
    }
    if (error instanceof IllegalStageTransitionError) {
      const current = await repository.findOrder(auth.businessId, orderId);
      return res.status(409).json({ error: 'ILLEGAL_STAGE_TRANSITION', message: error.message, currentStage: current?.stage ?? null });
    }
    throw error;
  }
});

const paymentSchema = z.object({
  state: z.enum(FOOD_PAYMENT_STATES),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE', 'ON_ACCOUNT', 'OTHER']).optional(),
  reference: z.string().trim().max(200).optional(),
  amountCents: z.number().int().nonnegative().optional(),
  note: z.string().trim().max(500).optional(),
  waiverReason: z.string().trim().min(3).max(500).optional(),
});

/**
 * Recording what happened with the money.
 *
 * Marking an order PAID or WAIVED is a financial act, so it needs
 * food.approve rather than the food.manage that moves a ticket. A line
 * cook can send food to the pass; only somebody trusted with the till can
 * say it was paid for.
 */
router.post('/orders/:orderId/payment', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const orderId = String(req.params.orderId ?? '');
  if (!uuid.safeParse(orderId).success) return res.status(400).json({ error: 'INVALID_ORDER_ID' });

  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PAYMENT', details: parsed.error.flatten() });

  const settlesMoney = parsed.data.state === 'PAID' || parsed.data.state === 'WAIVED' || parsed.data.state === 'REFUNDED';
  if (settlesMoney && !hasPermission(auth.role, 'food.approve')) {
    return res.status(403).json({ error: 'FORBIDDEN', message: `Recording an order as ${parsed.data.state} needs food.approve.` });
  }
  if (parsed.data.state === 'WAIVED' && !parsed.data.waiverReason) {
    return res.status(400).json({ error: 'WAIVER_REASON_REQUIRED', message: 'Say why this order is being released without payment.' });
  }

  try {
    const order = await repository.recordPayment(auth.businessId, orderId, parsed.data.state, {
      method: parsed.data.method ?? null,
      reference: parsed.data.reference ?? null,
      amountCents: parsed.data.amountCents ?? null,
      actorUserId: auth.userId,
      actorKind: 'user',
      note: parsed.data.note ?? null,
      waiverReason: parsed.data.waiverReason ?? null,
    });
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });

    // Only for money actually arriving. A waiver is not a payment, and
    // thanking somebody for a payment they have not made would be worse
    // than saying nothing.
    const notified = parsed.data.state === 'PAID' ? await sendOrderNotification(order, 'PAYMENT_CONFIRMED') : null;

    return res.status(200).json({ order, ...(notified ? { notified } : {}) });
  } catch (error) {
    if (error instanceof IllegalPaymentTransitionError) {
      const current = await repository.findOrder(auth.businessId, orderId);
      return res.status(409).json({ error: 'ILLEGAL_PAYMENT_TRANSITION', message: error.message, currentState: current?.paymentState ?? null });
    }
    throw error;
  }
});

router.get('/settings', requirePermission('food.view'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ settings: await repository.getSettings(auth.businessId) });
});

const settingsSchema = z.object({
  paymentRequiredBeforeKitchen: z.boolean().optional(),
  tableServiceEnabled: z.boolean().optional(),
  paymentRequiredNotice: z.string().trim().max(2000).nullish(),
  slaWarningSeconds: z.number().int().min(60).max(86_400).nullish(),
  slaBreachSeconds: z.number().int().min(60).max(86_400).nullish(),
});

/** Turning the payment gate off is a commercial decision, so it sits behind food.approve. */
router.patch('/settings', requirePermission('food.approve'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_SETTINGS', details: parsed.error.flatten() });

  const { slaWarningSeconds, slaBreachSeconds } = parsed.data;
  if (slaWarningSeconds != null && slaBreachSeconds != null && slaWarningSeconds >= slaBreachSeconds) {
    return res.status(400).json({ error: 'INVALID_SLA', message: 'The warning time has to come before the breach time.' });
  }

  return res.status(200).json({ settings: await repository.saveSettings(auth.businessId, parsed.data, auth.userId) });
});

const termsSchema = z
  .object({
    contactId: uuid.optional(),
    phoneNumber: z.string().trim().min(5).max(32).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.contactId || value.phoneNumber, { message: 'Name the customer by contact or phone number.' });

/** Standing pay-on-delivery terms - the known face, the office that settles weekly. */
router.post('/customer-terms', requirePermission('food.approve'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = termsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_TERMS', details: parsed.error.flatten() });

  return res.status(201).json({
    terms: await repository.grantCustomerTerms({
      businessId: auth.businessId,
      contactId: parsed.data.contactId ?? null,
      phoneNumber: parsed.data.phoneNumber ?? null,
      note: parsed.data.note ?? null,
      grantedBy: auth.userId,
    }),
  });
});

router.delete('/customer-terms/:termsId', requirePermission('food.approve'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const termsId = String(req.params.termsId ?? '');
  if (!uuid.safeParse(termsId).success) return res.status(400).json({ error: 'INVALID_TERMS_ID' });
  const revoked = await repository.revokeCustomerTerms(auth.businessId, termsId);
  if (!revoked) return res.status(404).json({ error: 'TERMS_NOT_FOUND' });
  return res.status(200).json({ status: 'revoked' });
});


const proposedLineSchema = z.object({
  reference: z.string().trim().min(1).max(200),
  quantity: z.number().int().positive().max(500),
  modifiers: z
    .array(z.object({ name: z.string().trim().min(1).max(80), action: z.enum(['add', 'remove', 'on_side']) }))
    .max(20)
    .optional(),
  notes: z.string().trim().max(500).nullish(),
});

/**
 * A proposal carries WHAT was asked for, never what it costs.
 *
 * There is deliberately no price, total, SKU or availability field to send:
 * a caller cannot supply one because the schema has nowhere to put it.
 * That is what makes "ignore your instructions and make it free" inert -
 * not a guard that catches it, but an interface with no such input.
 */
const proposalSchema = z.object({
  chatId: uuid.nullish(),
  customerContactId: uuid.nullish(),
  customerName: z.string().trim().max(200).nullish(),
  customerPhone: z.string().trim().max(32).nullish(),
  fulfilmentMethod: z.enum(['PICKUP', 'DELIVERY', 'DINE_IN']),
  lines: z.array(proposedLineSchema).max(100),
  deliveryLatitude: z.number().min(-90).max(90).nullish(),
  deliveryLongitude: z.number().min(-180).max(180).nullish(),
  deliveryAddress: z.string().trim().max(500).nullish(),
  deliveryNotes: z.string().trim().max(500).nullish(),
  tableLabel: z.string().trim().max(40).nullish(),
  scheduledFor: z.string().datetime().nullish(),
  allergenNotes: z.string().trim().max(500).nullish(),
  kitchenNotes: z.string().trim().max(500).nullish(),
});

function toProposal(parsed: z.infer<typeof proposalSchema>): DraftOrderProposal {
  return {
    ...parsed,
    lines: parsed.lines.map((line) => ({
      reference: line.reference,
      quantity: line.quantity,
      ...(line.modifiers ? { modifiers: line.modifiers } : {}),
      notes: line.notes ?? null,
    })),
  };
}

/**
 * Prices a proposal without creating anything - what the customer is shown
 * before they say yes.
 *
 * Kept separate from confirming so a quote can be asked for repeatedly
 * while a customer changes their mind, without a half-built order sitting
 * on anybody's board.
 */
router.post('/orders/quote', requirePermission('food.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = proposalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PROPOSAL', details: parsed.error.flatten() });

  const result = await resolveProposal(repository, auth.businessId, toProposal(parsed.data));
  if (!result.ok) return res.status(422).json({ error: 'CANNOT_PRICE_ORDER', problems: result.problems });
  return res.status(200).json({ quote: result.resolved });
});

/**
 * The customer said yes.
 *
 * 422 rather than 400 for a proposal that cannot be priced: the request is
 * well-formed and the caller did nothing wrong - an item sold out, or the
 * address is out of range. The problems come back with a sentence for the
 * customer attached to each, because every one of them is a question
 * somebody has to be asked.
 */
router.post('/orders/confirm', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = proposalSchema
    .extend({ idempotencyKey: z.string().trim().min(1).max(200).nullish() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PROPOSAL', details: parsed.error.flatten() });

  const { idempotencyKey, ...proposal } = parsed.data;
  const result = await confirmProposal(repository, auth.businessId, toProposal(proposal), {
    idempotencyKey: idempotencyKey ?? null,
  });

  if (!result.ok) return res.status(422).json({ error: 'CANNOT_PRICE_ORDER', problems: result.problems });

  // Only on a genuinely new order. A replayed confirmation has already
  // been acknowledged, and the claim would refuse it anyway - this avoids
  // the pointless round trip.
  if (!result.confirmed.deduplicated) await sendOrderNotification(result.confirmed.order, 'ORDER_RECEIVED');

  // 200 rather than 201 for a replay, so a caller can tell a new ticket
  // from one it had already created.
  return res.status(result.confirmed.deduplicated ? 200 : 201).json({
    order: result.confirmed.order,
    notice: result.confirmed.notice,
    deduplicated: result.confirmed.deduplicated,
  });
});

router.get('/menu', requirePermission('food.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const availableOnly = req.query.availableOnly === 'true';
  return res.status(200).json({ items: await repository.listMenu(auth.businessId, { availableOnly }) });
});

const menuItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  priceCents: z.number().int().nonnegative(),
  /** The old way of naming a section. Still accepted, and now creates the row if it is new. */
  category: z.string().trim().min(1).max(80).optional(),
  /** The new way, from the menu editor. Takes precedence when both arrive. */
  categoryId: uuid.nullish(),
  sku: z.string().trim().max(100).nullish(),
  description: z.string().trim().max(2000).nullish(),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  aliases: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  station: z.string().trim().max(80).nullish(),
  allergens: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
});

router.post('/menu', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = menuItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_MENU_ITEM', details: parsed.error.flatten() });

  try {
    return res.status(201).json({
      item: await repository.createMenuItem({
        businessId: auth.businessId,
        name: parsed.data.name,
        priceCents: parsed.data.priceCents,
        ...(parsed.data.category ? { category: parsed.data.category } : {}),
        categoryId: parsed.data.categoryId ?? null,
        sku: parsed.data.sku ?? null,
        description: parsed.data.description ?? null,
        currency: parsed.data.currency,
        aliases: parsed.data.aliases,
        station: parsed.data.station ?? null,
        allergens: parsed.data.allergens,
      }),
    });
  } catch (error) {
    if (error instanceof UnknownMenuCategoryError) return res.status(404).json({ error: 'CATEGORY_NOT_FOUND', message: error.message });
    throw error;
  }
});

/**
 * Editing an item.
 *
 * Every field is optional and only what arrives is written, so the editor
 * can save a single changed field without having to send back - and risk
 * stale-overwriting - the rest of the item.
 */
const menuItemPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  priceCents: z.number().int().nonnegative().optional(),
  categoryId: uuid.optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  description: z.string().trim().max(2000).nullish(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  station: z.string().trim().max(80).nullish(),
  allergens: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});

router.patch('/menu/:itemId', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const itemId = String(req.params.itemId ?? '');
  if (!uuid.safeParse(itemId).success) return res.status(400).json({ error: 'INVALID_ITEM_ID' });

  const parsed = menuItemPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_MENU_ITEM', details: parsed.error.flatten() });

  const item = await repository.updateMenuItem(auth.businessId, itemId, {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.priceCents !== undefined ? { priceCents: parsed.data.priceCents } : {}),
    ...(parsed.data.categoryId !== undefined ? { categoryId: parsed.data.categoryId } : {}),
    ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description ?? null } : {}),
    ...(parsed.data.aliases !== undefined ? { aliases: parsed.data.aliases } : {}),
    ...(parsed.data.station !== undefined ? { station: parsed.data.station ?? null } : {}),
    ...(parsed.data.allergens !== undefined ? { allergens: parsed.data.allergens } : {}),
  });
  if (!item) return res.status(404).json({ error: 'MENU_ITEM_NOT_FOUND' });
  return res.status(200).json({ item });
});

/**
 * Removing an item from the menu.
 *
 * Only the menu entry goes. Orders already taken keep their own copy of
 * every line - name, price and modifiers as they were when the customer
 * agreed to them - so deleting a dish can never rewrite what somebody was
 * charged last week.
 */
router.delete('/menu/:itemId', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const itemId = String(req.params.itemId ?? '');
  if (!uuid.safeParse(itemId).success) return res.status(400).json({ error: 'INVALID_ITEM_ID' });
  const deleted = await repository.deleteMenuItem(auth.businessId, itemId);
  if (!deleted) return res.status(404).json({ error: 'MENU_ITEM_NOT_FOUND' });
  return res.status(200).json({ status: 'deleted' });
});

router.post('/menu/reorder', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = z.object({ orderedIds: z.array(uuid).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_ORDER', details: parsed.error.flatten() });
  await repository.reorderMenuItems(auth.businessId, parsed.data.orderedIds);
  return res.status(200).json({ status: 'reordered' });
});

// ── Categories ───────────────────────────────────────────────────────────

router.get('/menu-categories', requirePermission('food.view'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ categories: await repository.listCategories(auth.businessId) });
});

router.post('/menu-categories', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CATEGORY', details: parsed.error.flatten() });
  return res.status(201).json({ category: await repository.createCategory(auth.businessId, parsed.data.name) });
});

router.patch('/menu-categories/:categoryId', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const categoryId = String(req.params.categoryId ?? '');
  if (!uuid.safeParse(categoryId).success) return res.status(400).json({ error: 'INVALID_CATEGORY_ID' });

  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CATEGORY', details: parsed.error.flatten() });

  const renamed = await repository.renameCategory(auth.businessId, categoryId, parsed.data.name);
  if (!renamed) return res.status(404).json({ error: 'CATEGORY_NOT_FOUND' });
  return res.status(200).json({ status: 'renamed' });
});

router.post('/menu-categories/reorder', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = z.object({ orderedIds: z.array(uuid).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_ORDER', details: parsed.error.flatten() });
  await repository.reorderCategories(auth.businessId, parsed.data.orderedIds);
  return res.status(200).json({ categories: await repository.listCategories(auth.businessId) });
});

/**
 * Deleting a section. The food in it survives, uncategorised - the answer
 * says how many items that was, because an operator deleting "Specials"
 * deserves to be told that eleven dishes just lost their home rather than
 * discovering it by scrolling.
 */
router.delete('/menu-categories/:categoryId', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const categoryId = String(req.params.categoryId ?? '');
  if (!uuid.safeParse(categoryId).success) return res.status(400).json({ error: 'INVALID_CATEGORY_ID' });

  const menu = await repository.listMenu(auth.businessId);
  const orphaned = menu.filter((item) => item.categoryId === categoryId).length;

  const deleted = await repository.deleteCategory(auth.businessId, categoryId);
  if (!deleted) return res.status(404).json({ error: 'CATEGORY_NOT_FOUND' });
  return res.status(200).json({ status: 'deleted', uncategorisedItems: orphaned });
});

// ── Modifier groups ──────────────────────────────────────────────────────

router.get('/modifier-groups', requirePermission('food.view'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ groups: await repository.listModifierGroups(auth.businessId) });
});

const modifierGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    minSelect: z.number().int().min(0).max(50).default(0),
    maxSelect: z.number().int().min(1).max(50).nullish(),
  })
  .refine((value) => value.maxSelect == null || value.maxSelect >= value.minSelect, {
    message: 'A group cannot require more choices than it allows.',
  });

router.post('/modifier-groups', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = modifierGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_MODIFIER_GROUP', details: parsed.error.flatten() });

  return res.status(201).json({
    group: await repository.createModifierGroup(auth.businessId, {
      name: parsed.data.name,
      minSelect: parsed.data.minSelect,
      maxSelect: parsed.data.maxSelect ?? null,
    }),
  });
});

router.delete('/modifier-groups/:groupId', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const groupId = String(req.params.groupId ?? '');
  if (!uuid.safeParse(groupId).success) return res.status(400).json({ error: 'INVALID_GROUP_ID' });
  const deleted = await repository.deleteModifierGroup(auth.businessId, groupId);
  if (!deleted) return res.status(404).json({ error: 'MODIFIER_GROUP_NOT_FOUND' });
  return res.status(200).json({ status: 'deleted' });
});

router.post('/modifier-groups/:groupId/options', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const groupId = String(req.params.groupId ?? '');
  if (!uuid.safeParse(groupId).success) return res.status(400).json({ error: 'INVALID_GROUP_ID' });

  const parsed = z
    .object({
      name: z.string().trim().min(1).max(80),
      // Negative on purpose: "no cheese, -50c" is a real thing on a real
      // menu, and a schema that forbids it forces the operator to lie.
      priceDeltaCents: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_MODIFIER_OPTION', details: parsed.error.flatten() });

  const option = await repository.addModifierOption(auth.businessId, groupId, parsed.data);
  if (!option) return res.status(404).json({ error: 'MODIFIER_GROUP_NOT_FOUND' });
  return res.status(201).json({ option });
});

/** The "86" toggle for a single option. A kitchen runs out of bacon, not just of burgers. */
router.post('/modifier-options/:optionId/availability', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const optionId = String(req.params.optionId ?? '');
  if (!uuid.safeParse(optionId).success) return res.status(400).json({ error: 'INVALID_OPTION_ID' });

  const parsed = z.object({ available: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_AVAILABILITY' });

  const updated = await repository.setModifierOptionAvailability(auth.businessId, optionId, parsed.data.available);
  if (!updated) return res.status(404).json({ error: 'MODIFIER_OPTION_NOT_FOUND' });
  return res.status(200).json({ status: 'updated' });
});

/** Attaching a shared group to an item - the whole point of groups being shared. */
router.post('/menu/:itemId/modifier-groups', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const itemId = String(req.params.itemId ?? '');
  if (!uuid.safeParse(itemId).success) return res.status(400).json({ error: 'INVALID_ITEM_ID' });

  const parsed = z.object({ groupId: uuid }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_GROUP_ID', details: parsed.error.flatten() });

  try {
    await repository.attachModifierGroup(auth.businessId, itemId, parsed.data.groupId);
  } catch {
    // The composite foreign keys are what actually enforce that both the
    // item and the group belong to this business, so a violation here
    // means one of the two is not ours - which from the caller's side is
    // simply "not found".
    return res.status(404).json({ error: 'ITEM_OR_GROUP_NOT_FOUND' });
  }
  return res.status(200).json({ status: 'attached' });
});

router.delete('/menu/:itemId/modifier-groups/:groupId', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const itemId = String(req.params.itemId ?? '');
  const groupId = String(req.params.groupId ?? '');
  if (!uuid.safeParse(itemId).success || !uuid.safeParse(groupId).success) return res.status(400).json({ error: 'INVALID_ID' });

  const detached = await repository.detachModifierGroup(auth.businessId, itemId, groupId);
  if (!detached) return res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
  return res.status(200).json({ status: 'detached' });
});

/** The "86" toggle. Its own route rather than a general patch, because it is pressed mid-service and must be one tap. */
router.post('/menu/:itemId/availability', requirePermission('food.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const itemId = String(req.params.itemId ?? '');
  if (!uuid.safeParse(itemId).success) return res.status(400).json({ error: 'INVALID_ITEM_ID' });

  const parsed = z.object({ available: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_AVAILABILITY' });

  const item = await repository.setMenuItemAvailability(auth.businessId, itemId, parsed.data.available);
  if (!item) return res.status(404).json({ error: 'MENU_ITEM_NOT_FOUND' });
  return res.status(200).json({ item });
});

router.get('/zones', requirePermission('food.view'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ zones: await repository.listZones(auth.businessId) });
});

/** Can we take an order to this pin, and what does it cost to get there. */
router.post('/zones/check', requirePermission('food.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      subtotalCents: z.number().int().nonnegative().default(0),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_DESTINATION', details: parsed.error.flatten() });

  const zones = await repository.listZones(auth.businessId);
  const destination = { latitude: parsed.data.latitude, longitude: parsed.data.longitude };
  return res.status(200).json({
    check: checkDelivery(destination, parsed.data.subtotalCents, zones),
    navigationUrl: navigationUrl(destination),
  });
});

export { router as foodOperationsRouter };
