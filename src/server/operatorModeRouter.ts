import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { OperatorModeRepository } from '../repositories/operatorModeRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppOutboundMessageService } from '../services/whatsappOutboundMessageService.js';
import { generatePinSalt, generateSetupToken, hashPin, OPERATOR_SETUP_CONFIRMATION } from '../services/operator/operatorCommandService.js';
import type { AuthContext } from './authMiddleware.js';

const router = Router();
const repo = new OperatorModeRepository(pool);
const chatRepo = new WhatsAppChatRepository(pool);
const outboundSvc = new WhatsAppOutboundMessageService();

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

  // Fire-and-forget: send a confirmation WhatsApp message to the operator's personal number.
  // This requires the operator to have messaged the business number at least once so a chat row exists.
  void (async () => {
    try {
      type AccountRow = { id: string };
      const { rows: accts } = await pool.query<AccountRow>(
        `SELECT id FROM whatsapp_accounts WHERE business_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
        [auth.businessId],
      );
      const whatsappAccountId = accts[0]?.id;
      if (!whatsappAccountId) return;

      const normalJid = operatorWaJid.includes('@') ? operatorWaJid : `${operatorWaJid}@s.whatsapp.net`;
      const chat = await chatRepo.findByJid(auth.businessId, whatsappAccountId, normalJid);
      if (!chat) return;

      await outboundSvc.send({
        businessId: auth.businessId,
        whatsappAccountId,
        chatId: chat.id,
        idempotencyKey: `operator-setup-confirm:${auth.businessId}:${Date.now()}`,
        messageType: 'text',
        text: OPERATOR_SETUP_CONFIRMATION,
        requestedBy: 'ai',
      });
    } catch {
      // Non-fatal — setup is saved; message will be shown in app instead.
    }
  })();

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

// POST /api/operator-mode/setup-token — generate a new one-time WhatsApp setup code.
// Returns the plain-text code ONCE. It is stored only as a scrypt hash.
router.post('/setup-token', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const plain = generateSetupToken();
  const salt = generatePinSalt();
  const hash = hashPin(plain, salt);
  await repo.upsertSetupToken(auth.businessId, hash, salt);
  return res.json({ token: plain });
});

// GET /api/operator-mode/setup-token — check whether a setup token exists (not its value)
router.get('/setup-token', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const exists = await repo.hasSetupToken(auth.businessId);
  return res.json({ exists });
});

// DELETE /api/operator-mode/setup-token — revoke the active setup token
router.delete('/setup-token', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  await repo.deleteSetupToken(auth.businessId);
  return res.json({ ok: true });
});

export { router as operatorModeRouter };
