import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { PropertyConversationBindingRepository } from '../repositories/propertyConversationBindingRepository.js';
import { PropertyOperationsRepository } from '../repositories/propertyOperationsRepository.js';
import { requireAuth, requirePermission, requireProductAccess, type AuthContext } from './authMiddleware.js';

const router = Router();
const bindings = new PropertyConversationBindingRepository(pool);
const properties = new PropertyOperationsRepository(pool);
const uuid = z.string().uuid();
router.use(requireAuth);
router.use(requireProductAccess('property'));

router.get('/:chatId', requirePermission('property.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const chatId = String(req.params.chatId ?? '');
  if (!uuid.safeParse(chatId).success) return res.status(400).json({ error: 'INVALID_CHAT_ID' });
  return res.status(200).json({ binding: await bindings.get(auth.businessId, chatId) });
});

const upsertSchema = z.object({ propertyId: uuid, unitId: uuid.nullish(), reservationId: uuid.nullish() });
router.put('/:chatId', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const chatId = String(req.params.chatId ?? '');
  if (!uuid.safeParse(chatId).success) return res.status(400).json({ error: 'INVALID_CHAT_ID' });
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PROPERTY_BINDING', details: parsed.error.flatten() });
  const property = await properties.getProperty(auth.businessId, parsed.data.propertyId);
  if (!property) return res.status(404).json({ error: 'PROPERTY_NOT_FOUND' });
  if (parsed.data.unitId !== null && parsed.data.unitId !== undefined) {
    const units = await properties.getUnit(auth.businessId, parsed.data.unitId);
    if (!units || units.propertyId !== property.id) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  }
  const bindingInput: { businessId: string; chatId: string; propertyId: string; unitId?: string | null; reservationId?: string | null } = { businessId: auth.businessId, chatId, propertyId: property.id };
  if (parsed.data.unitId !== undefined) bindingInput.unitId = parsed.data.unitId;
  if (parsed.data.reservationId !== undefined) bindingInput.reservationId = parsed.data.reservationId;
  return res.status(200).json({ binding: await bindings.upsert(bindingInput) });
});

router.delete('/:chatId', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const chatId = String(req.params.chatId ?? '');
  if (!uuid.safeParse(chatId).success) return res.status(400).json({ error: 'INVALID_CHAT_ID' });
  await bindings.remove(auth.businessId, chatId);
  return res.status(204).end();
});

export { router as propertyConversationBindingRouter };
