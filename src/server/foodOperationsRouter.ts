import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { FoodOperationsRepository, IllegalStageTransitionError } from '../repositories/foodOperationsRepository.js';
import { FOOD_ORDER_STAGES, bumpTarget, elapsedSeconds, slaBand } from '../domain/food/orderLifecycle.js';
import { checkDelivery, navigationUrl } from '../domain/food/deliveryZone.js';
import { requireAuth, requirePermission, requireProductAccess, type AuthContext } from './authMiddleware.js';

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
  const now = new Date();

  return res.status(200).json({
    serverTime: now.toISOString(),
    orders: orders.map((order) => {
      const elapsed = elapsedSeconds(order, now);
      return {
        ...order,
        elapsedSeconds: elapsed,
        slaBand: slaBand(elapsed),
        nextStage: bumpTarget(order.stage, order.fulfilmentMethod),
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

  try {
    const order = await repository.moveToStage(auth.businessId, orderId, parsed.data.stage, {
      userId: auth.userId,
      kind: 'user',
      note: parsed.data.note ?? null,
    });
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    return res.status(200).json({ order });
  } catch (error) {
    if (error instanceof IllegalStageTransitionError) {
      const current = await repository.findOrder(auth.businessId, orderId);
      return res.status(409).json({ error: 'ILLEGAL_STAGE_TRANSITION', message: error.message, currentStage: current?.stage ?? null });
    }
    throw error;
  }
});

router.get('/menu', requirePermission('food.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const availableOnly = req.query.availableOnly === 'true';
  return res.status(200).json({ items: await repository.listMenu(auth.businessId, { availableOnly }) });
});

const menuItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  priceCents: z.number().int().nonnegative(),
  category: z.string().trim().min(1).max(80).default('GENERAL'),
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

  return res.status(201).json({
    item: await repository.createMenuItem({
      businessId: auth.businessId,
      name: parsed.data.name,
      priceCents: parsed.data.priceCents,
      category: parsed.data.category,
      sku: parsed.data.sku ?? null,
      description: parsed.data.description ?? null,
      currency: parsed.data.currency,
      aliases: parsed.data.aliases,
      station: parsed.data.station ?? null,
      allergens: parsed.data.allergens,
    }),
  });
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
