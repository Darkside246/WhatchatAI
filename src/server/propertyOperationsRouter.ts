import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { PropertyOperationsRepository } from '../repositories/propertyOperationsRepository.js';
import { PropertyOperationsService } from '../services/property/propertyOperationsService.js';
import { PropertyContextService } from '../services/property/propertyContextService.js';
import { runPropertyMaintenanceTriage } from '../services/property/propertyMaintenanceAgentService.js';
import { requireAuth, requirePermission, type AuthContext } from './authMiddleware.js';

const router = Router();
const repository = new PropertyOperationsRepository(pool);
const operations = new PropertyOperationsService(repository);
const contextService = new PropertyContextService(repository);

router.use(requireAuth);

const uuid = z.string().uuid();
const propertySchema = z.object({
  name: z.string().trim().min(1).max(200), propertyType: z.string().trim().min(1).max(50).default('VILLA'), status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).default('ACTIVE'),
  addressLine1: z.string().trim().max(500).nullish(), addressLine2: z.string().trim().max(500).nullish(), city: z.string().trim().max(200).nullish(), countryCode: z.string().trim().length(2).toUpperCase().nullish(),
  timezone: z.string().trim().max(100).nullish(), guestInstructions: z.string().max(10000).nullish(), emergencyInstructions: z.string().max(10000).nullish(),
});

router.get('/properties', requirePermission('property.view'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ properties: await operations.listProperties(auth.businessId) });
});

router.get('/properties/:propertyId', requirePermission('property.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const propertyId = String(req.params.propertyId ?? '');
  if (!uuid.safeParse(propertyId).success) return res.status(400).json({ error: 'INVALID_PROPERTY_ID' });
  const property = await operations.getProperty(auth.businessId, propertyId);
  if (!property) return res.status(404).json({ error: 'PROPERTY_NOT_FOUND' });
  return res.status(200).json({ property });
});

router.post('/properties', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const parsed = propertySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PROPERTY', details: parsed.error.flatten() });
  const property = await operations.createProperty({ id: randomUUID(), businessId: auth.businessId, name: parsed.data.name, propertyType: parsed.data.propertyType, status: parsed.data.status, addressLine1: parsed.data.addressLine1 ?? null, addressLine2: parsed.data.addressLine2 ?? null, city: parsed.data.city ?? null, countryCode: parsed.data.countryCode ?? null, timezone: parsed.data.timezone ?? null, guestInstructions: parsed.data.guestInstructions ?? null, emergencyInstructions: parsed.data.emergencyInstructions ?? null });
  return res.status(201).json({ property });
});

router.get('/properties/:propertyId/units', requirePermission('property.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const propertyId = String(req.params.propertyId ?? '');
  if (!uuid.safeParse(propertyId).success) return res.status(400).json({ error: 'INVALID_PROPERTY_ID' });
  if (!await operations.getProperty(auth.businessId, propertyId)) return res.status(404).json({ error: 'PROPERTY_NOT_FOUND' });
  return res.status(200).json({ units: await operations.listUnits(auth.businessId, propertyId) });
});

const unitSchema = z.object({ name: z.string().trim().min(1).max(200), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'), metadata: z.record(z.string(), z.unknown()).default({}) });
router.post('/properties/:propertyId/units', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const propertyId = String(req.params.propertyId ?? '');
  if (!uuid.safeParse(propertyId).success) return res.status(400).json({ error: 'INVALID_PROPERTY_ID' });
  if (!await operations.getProperty(auth.businessId, propertyId)) return res.status(404).json({ error: 'PROPERTY_NOT_FOUND' });
  const parsed = unitSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'INVALID_UNIT', details: parsed.error.flatten() });
  return res.status(201).json({ unit: await operations.createUnit({ id: randomUUID(), businessId: auth.businessId, propertyId, ...parsed.data }) });
});

router.get('/units/:unitId/assets', requirePermission('property.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const unitId = String(req.params.unitId ?? '');
  if (!uuid.safeParse(unitId).success) return res.status(400).json({ error: 'INVALID_UNIT_ID' });
  if (!await operations.getUnit(auth.businessId, unitId)) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  return res.status(200).json({ assets: await operations.listAssets(auth.businessId, unitId) });
});

const assetSchema = z.object({ category: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(200), manufacturer: z.string().trim().max(200).nullish(), model: z.string().trim().max(200).nullish(), serialNumber: z.string().trim().max(200).nullish(), location: z.string().trim().max(300).nullish(), instructions: z.string().max(10000).nullish(), metadata: z.record(z.string(), z.unknown()).default({}) });
router.post('/units/:unitId/assets', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const unitId = String(req.params.unitId ?? '');
  if (!uuid.safeParse(unitId).success) return res.status(400).json({ error: 'INVALID_UNIT_ID' });
  if (!await operations.getUnit(auth.businessId, unitId)) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  const parsed = assetSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'INVALID_ASSET', details: parsed.error.flatten() });
  return res.status(201).json({ asset: await operations.createAsset({ id: randomUUID(), businessId: auth.businessId, unitId, ...parsed.data }) });
});

router.get('/vendors', requirePermission('property.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 80) : undefined;
  return res.status(200).json({ vendors: await operations.listVendors(auth.businessId, category) });
});

const vendorSchema = z.object({ name: z.string().trim().min(1).max(200), serviceCategories: z.array(z.string().trim().min(1).max(80)).max(30).default([]), phone: z.string().trim().max(50).nullish(), whatsappAddress: z.string().trim().max(100).nullish(), email: z.string().email().nullish(), emergencyAvailable: z.boolean().default(false), metadata: z.record(z.string(), z.unknown()).default({}) });
router.post('/vendors', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const parsed = vendorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_VENDOR', details: parsed.error.flatten() });
  return res.status(201).json({ vendor: await operations.createVendor({ id: randomUUID(), businessId: auth.businessId, ...parsed.data }) });
});

router.get('/incidents', requirePermission('property.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const propertyId = typeof req.query.propertyId === 'string' ? req.query.propertyId : undefined;
  if (propertyId && !uuid.safeParse(propertyId).success) return res.status(400).json({ error: 'INVALID_PROPERTY_ID' });
  return res.status(200).json({ incidents: await operations.listIncidents(auth.businessId, propertyId) });
});

const intakeSchema = z.object({ propertyId: uuid, unitId: uuid.optional(), assetId: uuid.optional(), reservationId: uuid.optional(), reportedByContactId: uuid.optional(), channel: z.enum(['WHATSAPP', 'VOICE', 'SMS', 'EMAIL', 'WEB']), title: z.string().trim().max(200).optional(), description: z.string().trim().min(1).max(10000), aiSummary: z.string().max(4000).optional(), confidence: z.number().min(0).max(1).optional() });
router.post('/incidents/intake', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const parsed = intakeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_MAINTENANCE_INTAKE', details: parsed.error.flatten() });
  try { return res.status(201).json(await operations.intakeMaintenance({ businessId: auth.businessId, ...parsed.data })); }
  catch (error) { if (error instanceof Error && error.message === 'PROPERTY_NOT_FOUND') return res.status(404).json({ error: 'PROPERTY_NOT_FOUND' }); if (error instanceof Error && error.message === 'UNIT_NOT_FOUND') return res.status(404).json({ error: 'UNIT_NOT_FOUND' }); throw error; }
});

const triageSchema = z.object({ propertyId: uuid, unitId: uuid.optional(), assetId: uuid.optional(), conversationId: z.string().min(1).max(255), senderAddress: z.string().min(1).max(255), senderRole: z.enum(['GUEST', 'TENANT', 'STAFF', 'VENDOR', 'UNKNOWN']).default('GUEST'), messageType: z.enum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'CALL']), text: z.string().max(10000).optional(), mediaUrl: z.string().url().optional(), mimeType: z.string().max(200).optional(), durationMs: z.number().int().nonnegative().max(86_400_000).optional() });
router.post('/triage', requirePermission('property.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const parsed = triageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_TRIAGE_REQUEST', details: parsed.error.flatten() });
  if (!['WHATSAPP', 'VOICE', 'SMS'].includes(parsed.data.messageType === 'CALL' ? 'VOICE' : 'WHATSAPP')) return res.status(400).json({ error: 'UNSUPPORTED_TRIAGE_CHANNEL' });
  try {
    const context = await contextService.build({ businessId: auth.businessId, propertyId: parsed.data.propertyId, unitId: parsed.data.unitId, assetId: parsed.data.assetId });
    const event = {
      id: randomUUID(), tenantId: auth.businessId, channel: parsed.data.messageType === 'CALL' ? 'VOICE' as const : 'WHATSAPP' as const,
      conversationId: parsed.data.conversationId, sender: { address: parsed.data.senderAddress, role: parsed.data.senderRole }, propertyId: parsed.data.propertyId,
      message: { type: parsed.data.messageType, text: parsed.data.text, mediaUrl: parsed.data.mediaUrl, mimeType: parsed.data.mimeType, durationMs: parsed.data.durationMs },
      occurredAt: new Date().toISOString(), correlationId: randomUUID(), idempotencyKey: `triage:${auth.businessId}:${parsed.data.conversationId}:${randomUUID()}`,
    };
    return res.status(200).json({ result: await runPropertyMaintenanceTriage({ event, context, agentId: 'property-maintenance-triage' }) });
  } catch (error) {
    if (error instanceof Error && ['PROPERTY_NOT_FOUND', 'UNIT_NOT_FOUND', 'ASSET_NOT_FOUND'].includes(error.message)) return res.status(404).json({ error: error.message });
    if (error instanceof Error && error.message.includes('skill property.maintenance.triage is disabled')) return res.status(503).json({ error: 'TRIAGE_DISABLED' });
    throw error;
  }
});

router.get('/knowledge', requirePermission('property.view'), async (req, res) => {
  const auth = res.locals.auth as AuthContext; const propertyId = typeof req.query.propertyId === 'string' ? req.query.propertyId : undefined; const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
  return res.status(200).json({ knowledge: await operations.listKnowledge(auth.businessId, propertyId, assetId) });
});

export { router as propertyOperationsRouter };
