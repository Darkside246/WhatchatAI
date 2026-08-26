import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../repositories/types.js';
import { PlatformActionRepository, type PlatformActionRow } from '../../repositories/platformActionRepository.js';
import type { ActionRequest } from '../../domain/platform/contracts.js';

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export class ApprovalService {
  constructor(private readonly db: Queryable, private readonly actions = new PlatformActionRepository(db)) {}

  async persistAction(action: ActionRequest): Promise<PlatformActionRow> {
    const row = await this.actions.create({
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
    if (row.approvalRequired && row.approvalStatus === 'PENDING' && row.status === 'PENDING_APPROVAL') {
      await this.actions.createApproval({
        id: randomUUID(),
        actionRequestId: row.id,
        businessId: row.businessId,
      });
    }
    return row;
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
    const action = await this.actions.getById(input.businessId, input.actionId);
    if (!action) throw new Error('ACTION_NOT_FOUND');
    if (action.approvalStatus !== 'PENDING' || action.status !== 'PENDING_APPROVAL') throw new Error('ACTION_NOT_PENDING_APPROVAL');

    const approval = await this.actions.decideApproval(input.businessId, action.id, input.userId, decision, input.reason);
    if (!approval) throw new Error('ACTION_NOT_PENDING_APPROVAL');

    const updated = await this.actions.updateState(input.businessId, action.id, {
      approvalStatus: decision,
      status: decision === 'APPROVED' ? 'READY' : 'CANCELLED',
    });
    if (!updated) throw new Error('ACTION_NOT_FOUND');
    return updated;
  }
}
