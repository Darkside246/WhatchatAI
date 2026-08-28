import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { OperatorModeRepository } from '../repositories/operatorModeRepository.js';
import { generatePinSalt, hashPin } from '../services/operator/operatorCommandService.js';
import type { AuthContext } from './authMiddleware.js';

const router = Router();
const repo = new OperatorModeRepository(pool);

const SetupSchema = z.object({
  operatorWaJid: z.string().min(5).max(64),
  pin: z.string().min(4).max(20),
  enabled: z.boolean().optional(),
});

// GET /api/operator-mode/settings
router.get('/settings', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const settings = await repo.getSettings(auth.businessId);
  if (!settings) return res.json({ configured: false });
  return res.json({
    configured: true,
    operatorWaJid: settings.operatorWaJid,
    enabled: settings.enabled,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  });
});

// POST /api/operator-mode/settings — create or update (PIN required to change)
router.post('/settings', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const parsed = SetupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_BODY', detail: parsed.error.flatten() });

  const { operatorWaJid, pin, enabled } = parsed.data;
  const salt = generatePinSalt();
  const hash = hashPin(pin, salt);

  const settings = await repo.upsertSettings({
    businessId: auth.businessId,
    operatorWaJid,
    pinSalt: salt,
    pinHash: hash,
    pinN: 16384,
    pinR: 8,
    pinP: 1,
    ...(enabled !== undefined ? { enabled } : {}),
  });

  return res.json({
    configured: true,
    operatorWaJid: settings.operatorWaJid,
    enabled: settings.enabled,
    updatedAt: settings.updatedAt,
  });
});

// PATCH /api/operator-mode/settings/enabled
router.patch('/settings/enabled', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_BODY' });
  await repo.setEnabled(auth.businessId, parsed.data.enabled);
  return res.json({ enabled: parsed.data.enabled });
});

// DELETE /api/operator-mode/session — force-kill any active session
router.delete('/session', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  await repo.deleteSession(auth.businessId);
  return res.json({ ok: true });
});

export { router as operatorModeRouter };
