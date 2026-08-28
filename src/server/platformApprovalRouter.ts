import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { ApprovalService } from '../services/platform/approvalService.js';
import { TriageFeedbackRepository } from '../repositories/triageFeedbackRepository.js';
import { PropertyOperationsRepository } from '../repositories/propertyOperationsRepository.js';
import { notifyBusiness } from '../services/notificationService.js';
import { requireAuth, requirePermission, type AuthContext } from './authMiddleware.js';

const router = Router();
const approvals = new ApprovalService(pool);
const feedbackRepo = new TriageFeedbackRepository(pool);
const propertyRepo = new PropertyOperationsRepository(pool);
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

    // ── Post-approval side effects (best-effort, never block the 200 response) ──
    void (async () => {
      try {
        // Record AI feedback for future triage calibration.
        const p = action.payload as Record<string, unknown>;
        if (typeof p.messageText === 'string' && typeof p.aiCategory === 'string') {
          await feedbackRepo.record({
            businessId: auth.businessId,
            actionRequestId: action.id,
            messageText: p.messageText,
            aiCategory: String(p.category ?? p.aiCategory ?? 'OTHER'),
            aiUrgency: String(p.urgency ?? 'ROUTINE'),
            aiConfidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
            humanDecision: 'APPROVED',
            decisionReason: body.data.reason ?? null,
          });
        }

        // For maintenance work order actions: create incident + work order.
        if (action.type === 'maintenance.create_work_order' && typeof p.propertyId === 'string') {
          const summary = typeof p.summary === 'string' ? p.summary : typeof p.messageText === 'string' ? p.messageText : 'Maintenance issue';
          const category = String(p.category ?? 'OTHER');
          const urgency = String(p.urgency ?? 'ROUTINE');
          const incident = await propertyRepo.createIncident({
            id: randomUUID(),
            businessId: auth.businessId,
            propertyId: p.propertyId,
            sourceChannel: 'WHATSAPP',
            title: `${category} — ${urgency}`,
            description: typeof p.messageText === 'string' ? p.messageText : summary,
            category,
            severity: urgency,
            status: 'OPEN',
            confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
            aiSummary: summary,
          });

          // Prefer a vendor that handles this category and is emergency-available.
          const vendors = await propertyRepo.listVendors(auth.businessId, category.toLowerCase());
          const vendor = vendors.find((v) => v.emergencyAvailable) ?? vendors[0];
          await propertyRepo.createWorkOrder({
            id: randomUUID(),
            businessId: auth.businessId,
            incidentId: incident.id,
            vendorId: vendor?.id,
            status: 'PENDING_APPROVAL',
            priority: urgency,
            description: summary,
          });
        }

        // Notify the team.
        await notifyBusiness({
          businessId: auth.businessId,
          type: 'HUMAN_HANDOFF',
          severity: 'info',
          title: 'Action request approved',
          body: `A maintenance action was approved${body.data.reason ? `: ${body.data.reason}` : ''}. A work order has been created.`,
        });
      } catch (err) {
        console.error('[PlatformApprovalRouter] Post-approval side-effect failed:', err instanceof Error ? err.message : err);
      }
    })();

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

    // ── Post-rejection side effects (best-effort) ──
    void (async () => {
      try {
        const p = action.payload as Record<string, unknown>;
        if (typeof p.messageText === 'string') {
          await feedbackRepo.record({
            businessId: auth.businessId,
            actionRequestId: action.id,
            messageText: p.messageText,
            aiCategory: String(p.category ?? 'OTHER'),
            aiUrgency: String(p.urgency ?? 'ROUTINE'),
            aiConfidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
            humanDecision: 'REJECTED',
            decisionReason: body.data.reason,
          });
        }

        await notifyBusiness({
          businessId: auth.businessId,
          type: 'HUMAN_HANDOFF',
          severity: 'info',
          title: 'Action request rejected',
          body: `A maintenance action was rejected: ${body.data.reason}`,
        });
      } catch (err) {
        console.error('[PlatformApprovalRouter] Post-rejection side-effect failed:', err instanceof Error ? err.message : err);
      }
    })();

    return res.status(200).json({ action });
  } catch (error) {
    if (error instanceof Error && error.message === 'ACTION_NOT_FOUND') return res.status(404).json({ error: 'ACTION_NOT_FOUND' });
    if (error instanceof Error && error.message === 'ACTION_NOT_PENDING_APPROVAL') return res.status(409).json({ error: 'ACTION_NOT_PENDING_APPROVAL' });
    throw error;
  }
});

export { router as platformApprovalRouter };
