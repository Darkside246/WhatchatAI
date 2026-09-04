import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { RetailOperationsRepository } from '../repositories/retailOperationsRepository.js';
import { RetailOperationsService } from '../services/retail/retailOperationsService.js';
import { RetailContextService } from '../services/retail/retailContextService.js';
import { runRetailOrderTriage } from '../services/retail/retailAgentService.js';
import { ApprovalService } from '../services/platform/approvalService.js';
import { RetailTriageFeedbackRepository } from '../repositories/retailTriageFeedbackRepository.js';
import { requireAuth, requirePermission, requireProductAccess, type AuthContext } from './authMiddleware.js';

const router = Router();
const repository = new RetailOperationsRepository(pool);
const operations = new RetailOperationsService(repository);
const contextService = new RetailContextService(repository);
const approvalService = new ApprovalService(pool);
const feedbackRepo = new RetailTriageFeedbackRepository(pool);
router.use(requireAuth);
router.use(requireProductAccess('retail'));
const uuid = z.string().uuid();

const productSchema = z.object({ name: z.string().trim().min(1).max(200), sku: z.string().trim().max(100).nullish(), category: z.string().trim().min(1).max(80).default('GENERAL'), status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).default('ACTIVE'), priceCents: z.number().int().nonnegative().default(0), currency: z.string().trim().length(3).toUpperCase().default('USD'), stockQuantity: z.number().int().nonnegative().nullish(), description: z.string().max(10000).nullish(), imageUrl: z.string().url().nullish() });
router.get('/products', requirePermission('retail.view'), async (req, res) => { const auth = res.locals.auth as AuthContext; const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 80) : undefined; return res.status(200).json({ products: category === undefined ? await operations.listProducts(auth.businessId) : await operations.listProducts(auth.businessId, category) }); });
router.get('/products/:productId', requirePermission('retail.view'), async (req, res) => { const auth = res.locals.auth as AuthContext; const productId = String(req.params.productId ?? ''); if (!uuid.safeParse(productId).success) return res.status(400).json({ error: 'INVALID_PRODUCT_ID' }); const product = await operations.getProduct(auth.businessId, productId); if (!product) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND' }); return res.status(200).json({ product }); });
router.post('/products', requirePermission('retail.manage'), async (req, res) => { const auth = res.locals.auth as AuthContext; const parsed = productSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'INVALID_PRODUCT', details: parsed.error.flatten() }); return res.status(201).json({ product: await operations.createProduct({ id: randomUUID(), businessId: auth.businessId, name: parsed.data.name, sku: parsed.data.sku ?? undefined, category: parsed.data.category, status: parsed.data.status, priceCents: parsed.data.priceCents, currency: parsed.data.currency, stockQuantity: parsed.data.stockQuantity ?? undefined, description: parsed.data.description ?? undefined, imageUrl: parsed.data.imageUrl ?? undefined }) }); });

router.get('/orders', requirePermission('retail.view'), async (req, res) => { const auth = res.locals.auth as AuthContext; const status = typeof req.query.status === 'string' ? req.query.status : undefined; return res.status(200).json({ orders: status === undefined ? await operations.listOrders(auth.businessId) : await operations.listOrders(auth.businessId, status) }); });
const orderItemSchema = z.object({ productId: uuid, name: z.string().trim().min(1).max(200), quantity: z.number().int().positive().max(1000), unitPriceCents: z.number().int().nonnegative() });
const intakeSchema = z.object({ customerContactId: uuid.optional(), sourceChannel: z.enum(['WHATSAPP', 'VOICE', 'SMS', 'EMAIL', 'WEB']), items: z.array(orderItemSchema).min(1).max(50), fulfillmentMethod: z.enum(['PICKUP', 'DELIVERY']).optional(), deliveryAddress: z.string().trim().max(500).optional(), notes: z.string().trim().max(10000).optional() });
router.post('/orders/intake', requirePermission('retail.manage'), async (req, res) => { const auth = res.locals.auth as AuthContext; const parsed = intakeSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'INVALID_ORDER_INTAKE', details: parsed.error.flatten() }); return res.status(201).json(await operations.intakeOrder({ businessId: auth.businessId, ...parsed.data })); });
const orderStatusSchema = z.object({ status: z.enum(['PENDING_APPROVAL', 'PENDING_POLICY', 'APPROVED', 'FULFILLED', 'CANCELLED']), notes: z.string().trim().max(10000).optional() });
router.patch('/orders/:orderId', requirePermission('retail.manage'), async (req, res) => { const auth = res.locals.auth as AuthContext; const orderId = String(req.params.orderId ?? ''); if (!uuid.safeParse(orderId).success) return res.status(400).json({ error: 'INVALID_ORDER_ID' }); const parsed = orderStatusSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'INVALID_ORDER_UPDATE', details: parsed.error.flatten() }); const updated = await operations.updateOrderStatus(auth.businessId, orderId, parsed.data.status, parsed.data.notes !== undefined ? { notes: parsed.data.notes } : undefined); if (!updated) return res.status(404).json({ error: 'ORDER_NOT_FOUND' }); return res.status(200).json({ order: updated }); });

const triageSchema = z.object({ conversationId: z.string().min(1).max(255), senderAddress: z.string().min(1).max(255), senderRole: z.enum(['GUEST', 'TENANT', 'STAFF', 'VENDOR', 'UNKNOWN']).default('GUEST'), channel: z.enum(['WHATSAPP', 'VOICE', 'SMS']).default('WHATSAPP'), text: z.string().min(1).max(10000) });
router.post('/triage', requirePermission('retail.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = triageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_TRIAGE_REQUEST', details: parsed.error.flatten() });
  try {
    const context = await contextService.build({ businessId: auth.businessId });
    const event = {
      id: randomUUID(), tenantId: auth.businessId, channel: parsed.data.channel, conversationId: parsed.data.conversationId,
      sender: { address: parsed.data.senderAddress, role: parsed.data.senderRole },
      message: { type: 'TEXT' as const, text: parsed.data.text },
      occurredAt: new Date().toISOString(), correlationId: randomUUID(),
      idempotencyKey: `retail-triage:${auth.businessId}:${parsed.data.channel}:${parsed.data.conversationId}:${parsed.data.text}`,
    };
    const result = await runRetailOrderTriage({ event, context, agentId: 'retail-order-triage', feedbackRepo });
    for (const action of result.actionRequests) {
      if (action.approval.required) {
        try { await approvalService.persistAction(action); }
        catch (err) { console.error('[RetailOpsRouter] Failed to persist action request:', err instanceof Error ? err.message : err); }
      }
    }
    return res.status(200).json({ result });
  } catch (error) {
    if (error instanceof Error && error.message.includes('skill retail.order.triage is disabled')) return res.status(503).json({ error: 'TRIAGE_DISABLED' });
    throw error;
  }
});

router.get('/notes', requirePermission('retail.view'), async (req, res) => { const auth = res.locals.auth as AuthContext; const productId = typeof req.query.productId === 'string' ? req.query.productId : ''; if (!uuid.safeParse(productId).success) return res.status(400).json({ error: 'INVALID_PRODUCT_ID' }); return res.status(200).json({ notes: await operations.listRetailNotes(auth.businessId, productId) }); });
const noteSchema = z.object({ note: z.string().trim().min(1).max(5000), createdByJid: z.string().trim().min(1).max(255) });
router.post('/products/:productId/notes', requirePermission('retail.manage'), async (req, res) => { const auth = res.locals.auth as AuthContext; const productId = String(req.params.productId ?? ''); if (!uuid.safeParse(productId).success) return res.status(400).json({ error: 'INVALID_PRODUCT_ID' }); if (!await operations.getProduct(auth.businessId, productId)) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND' }); const parsed = noteSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'INVALID_NOTE', details: parsed.error.flatten() }); return res.status(201).json({ note: await operations.createRetailNote({ id: randomUUID(), businessId: auth.businessId, productId, ...parsed.data }) }); });

export { router as retailOperationsRouter };
