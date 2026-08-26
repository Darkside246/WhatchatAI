import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../repositories/types.js';
import { PlatformActionRepository, type PlatformActionRow } from '../../repositories/platformActionRepository.js';
import type { ActionRequest } from '../../domain/platform/contracts.js';

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export class ApprovalService {
  constructor(private readonly db: Queryable, private readonly actions = new PlatformActionRepository(db)) {}

  async persistAction(action: ActionRequest): Promise<PlatformActionRow> {
    return this.actions.create({
      id: action.id,
      businessId: action.tenantId,
      type: action.type,
      payload: action.payload,
      requestedByKind: action.requestedBy.kind,
      requestedById: action.requestedBy.id,
      riskLevel: action.riskLevel,
      approvalRequired: action.approval.required,
      approvalStatus: action.approval.status,
      status: action.status,
      idempotencyKey: action.idempotencyKey,
      correlationId: action.correlationId,
    });
  }

  async approve(input: { businessId: string; actionId: string; userId: string; reason?: string }): Promise<PlatformActionRow> {
    return this.decide(input, 'APPROVED');
  }

  async reject(input: { businessId: string; actionId: string; userId: string; reason: string }): Promise<PlatformActionRow> {
    return this.decide(input, 'REJECTED');
  }

  async listPending(businessId: string): Promise<PlatformActionRow[]> {
    return this.actions.listPendingApprovals(businessId);
  }

  private async decide(input: { businessId: string; actionId: string; userId: string; reason?: string }, decision: ApprovalDecision): Promise<PlatformActionRow> {
    if (!input.userId) throw new Error('APPROVER_REQUIRED');
    const existing = await this.actions.getByIdempotencyKey(input.businessId, `approval:${input.actionId}`);
    if (existing) return existing;
    const action = await this.findAction(input.businessId, input.actionId);
    if (!action) throw new Error('ACTION_NOT_FOUND');
    if (action.approvalStatus !== 'PENDING' || action.status !== 'PENDING_APPROVAL') throw new Error('ACTION_NOT_PENDING_APPROVAL');
    const updated = await this.actions.updateState(input.businessId, action.id, {
      approvalStatus: decision,
      status: decision === 'APPROVED' ? 'READY' : 'CANCELLED',
    });
    if (!updated) throw new Error('ACTION_NOT_FOUND');
    return updated;
  }

  private async findAction(businessId: string, actionId: string): Promise<PlatformActionRow | null> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `SELECT id,business_id AS "businessId",type,payload,requested_by_kind AS "requestedByKind",requested_by_id AS "requestedById",risk_level AS "riskLevel",approval_required AS "approvalRequired",approval_status AS "approvalStatus",status,idempotency_key AS "idempotencyKey",correlation_id AS "correlationId",created_at AS "createdAt",updated_at AS "updatedAt"
       FROM platform_action_requests WHERE business_id = $1 AND id = $2`,
      [businessId, actionId],
    );
    return rows[0] ?? null;
  }

  createApprovalId(): string { return randomUUID(); }
}
