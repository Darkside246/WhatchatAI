import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { ApprovalService } from '../services/platform/approvalService.js';
import { TriageFeedbackRepository } from '../repositories/triageFeedbackRepository.js';
import { notifyBusiness } from '../services/notificationService.js';
import { requireAuth, requirePermission, type AuthContext } from './authMiddleware.js';
import { actionBusService } from '../services/platform/actionBusService.js';
import type { PlatformActionRow } from '../repositories/platformActionRepository.js';
import type { ActionRequest, AgentCapability } from '../domain/platform/contracts.js';

const router = Router();
const approvals = new ApprovalService(pool);
const feedbackRepo = new TriageFeedbackRepository(pool);
const uuid = z.string().uuid();

/** Maps the DB row back into the domain ActionRequest shape ActionBusService.execute() expects. Exported for direct unit testing. */
export function actionRowToRequest(row: PlatformActionRow): ActionRequest {
  return {
    id: row.id,
    tenantId: row.businessId,
    type: row.type,
    payload: row.payload,
    requestedBy: { kind: row.requestedByKind, id: row.requestedById },
    riskLevel: row.riskLevel,
    approval: { required: row.approvalRequired, status: row.approvalStatus },
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A human operator approving an action through this endpoint is a
 * different kind of authority than the AI agent capability that originally
 * proposed it - this synthesizes exactly enough capability to let
 * evaluateActionPolicy's checks pass for this one already-approved action,
 * scoped to nothing broader. agentId matches the original requester so the
 * "requester must match capability owner" check still holds when the
 * action was originally proposed by an agent. Exported for direct unit testing.
 */
export function humanApprovalCapability(action: ActionRequest): AgentCapability {
  return {
    id: `human-approval:${action.id}`,
    agentId: action.requestedBy.id,
    description: 'Synthetic capability representing a human operator dispatching an action they just approved.',
    allowedActions: [action.type],
    forbiddenActions: [],
    requiresApprovalFor: [],
    maxRiskLevel: 'CRITICAL',
  };
}

router.use(requireAuth);

router.get('/pending', requirePermission('property.approve'), async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ approvals: await approvals.listPending(auth.businessId) });
});

/**
 * Best-effort, post-decision work shared by the single-action and bulk
 * approve routes below - extracted so bundled approval ("Approve All")
 * gets the exact same triage-feedback recording and real ActionBus
 * dispatch as approving one action at a time, not a second, thinner
 * code path that quietly skips them.
 */
async function runPostApprovalSideEffects(action: PlatformActionRow, auth: AuthContext, reason: string | undefined): Promise<void> {
  try {
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
        decisionReason: reason ?? null,
      });
    }

    // Real dispatch through ActionBusService - the production execution
    // path for this action type, registered during platformBootstrap.ts's
    // initializePlatformFoundation(). Not every approved action type has a
    // registered executor (e.g. maintenance.request_human_review and
    // maintenance.contact_emergency_service have no further side effect
    // beyond the notification below) - DENIED for "no executor
    // registered" is an expected, benign outcome for those, not a failure
    // to alarm on. Only a genuine FAILED means the real side effect
    // (creating the incident/work order) did not happen.
    const actionRequest = actionRowToRequest(action);
    const dispatch = await actionBusService.execute(actionRequest, humanApprovalCapability(actionRequest), {
      tenantId: auth.businessId,
      actorId: auth.userId,
    });
    if (dispatch.status === 'FAILED') {
      console.error(`[PlatformApprovalRouter] ActionBus dispatch failed for action ${action.id} (${action.type}):`, dispatch.error);
    }

    // Notify the team - generic wording since this router is not
    // property-maintenance-specific, even though that is the only real
    // action type flowing through it today.
    const workOrderCreated = dispatch.status === 'SUCCEEDED' && action.type === 'maintenance.create_work_order';
    await notifyBusiness({
      businessId: auth.businessId,
      type: 'HUMAN_HANDOFF',
      severity: 'info',
      title: 'Action request approved',
      body: `An action request was approved${reason ? `: ${reason}` : ''}.${workOrderCreated ? ' A work order has been created.' : ''}`,
    });
  } catch (err) {
    console.error('[PlatformApprovalRouter] Post-approval side-effect failed:', err instanceof Error ? err.message : err);
  }
}

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

    // Best-effort, never blocks the 200 response.
    void runPostApprovalSideEffects(action, auth, body.data.reason);

    return res.status(200).json({ action });
  } catch (error) {
    if (error instanceof Error && error.message === 'ACTION_NOT_FOUND') return res.status(404).json({ error: 'ACTION_NOT_FOUND' });
    if (error instanceof Error && error.message === 'ACTION_NOT_PENDING_APPROVAL') return res.status(409).json({ error: 'ACTION_NOT_PENDING_APPROVAL' });
    throw error;
  }
});

/**
 * "Approve All" bundling (AURA Master Engineering Prompt section 9 -
 * "do not make users approve 30 tiny actions individually"). Each action
 * is approved independently, exactly as if POST /:actionId/approve were
 * called once per id - one action failing (already decided, deleted,
 * cross-tenant) never blocks or rolls back the others, and the response
 * reports every outcome individually so the operator can see exactly
 * what happened to each one.
 */
router.post('/bulk-approve', requirePermission('property.approve'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const body = z.object({ actionIds: z.array(z.string().uuid()).min(1).max(50), reason: z.string().trim().max(4000).optional() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'INVALID_BULK_APPROVAL_PAYLOAD' });

  const results = await Promise.all(
    body.data.actionIds.map(async (actionId) => {
      try {
        const input: { businessId: string; actionId: string; userId: string; reason?: string } = {
          businessId: auth.businessId,
          actionId,
          userId: auth.userId,
        };
        if (body.data.reason !== undefined) input.reason = body.data.reason;
        const action = await approvals.approve(input);
        void runPostApprovalSideEffects(action, auth, body.data.reason);
        return { actionId, status: 'approved' as const };
      } catch (error) {
        const code = error instanceof Error && (error.message === 'ACTION_NOT_FOUND' || error.message === 'ACTION_NOT_PENDING_APPROVAL')
          ? error.message
          : 'UNKNOWN_ERROR';
        return { actionId, status: 'failed' as const, error: code };
      }
    }),
  );

  return res.status(200).json({ results });
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
