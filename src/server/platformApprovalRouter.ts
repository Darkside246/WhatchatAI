import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { ApprovalService } from '../services/platform/approvalService.js';
import { requireAuth, requirePermission, type AuthContext } from './authMiddleware.js';

const router = Router();
const approvals = new ApprovalService(pool);
const uuid = z.string().uuid();

router.use(requireAuth);

router.get('/pending', requirePermission('property.approve'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ approvals: await approvals.listPending(auth.businessId) });
});

router.post('/:actionId/approve', requirePermission('property.approve'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const actionId = String(req.params.actionId ?? '');
  if (!uuid.safeParse(actionId).success) return res.status(400).json({ error: 'INVALID_ACTION_ID' });
  const body = z.object({ reason: z.string().trim().max(4000).optional() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'INVALID_APPROVAL_PAYLOAD' });
  try {
    const input: { businessId: string; actionId: string; userId: string; reason?: string } = {
      businessId: auth.businessId,
      actionId,
      userId: auth.userId,
    };
    if (body.data.reason !== undefined) input.reason = body.data.reason;
    const action = await approvals.approve(input);
    return res.status(200).json({ action });
  } catch (error) {
    if (error instanceof Error && error.message === 'ACTION_NOT_FOUND') return res.status(404).json({ error: 'ACTION_NOT_FOUND' });
    if (error instanceof Error && error.message === 'ACTION_NOT_PENDING_APPROVAL') return res.status(409).json({ error: 'ACTION_NOT_PENDING_APPROVAL' });
    throw error;
  }
});

router.post('/:actionId/reject', requirePermission('property.approve'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const actionId = String(req.params.actionId ?? '');
  if (!uuid.safeParse(actionId).success) return res.status(400).json({ error: 'INVALID_ACTION_ID' });
  const body = z.object({ reason: z.string().trim().min(1).max(4000) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'REJECTION_REASON_REQUIRED' });
  try {
    const action = await approvals.reject({ businessId: auth.businessId, actionId, userId: auth.userId, reason: body.data.reason });
    return res.status(200).json({ action });
  } catch (error) {
    if (error instanceof Error && error.message === 'ACTION_NOT_FOUND') return res.status(404).json({ error: 'ACTION_NOT_FOUND' });
    if (error instanceof Error && error.message === 'ACTION_NOT_PENDING_APPROVAL') return res.status(409).json({ error: 'ACTION_NOT_PENDING_APPROVAL' });
    throw error;
  }
});

export { router as platformApprovalRouter };
