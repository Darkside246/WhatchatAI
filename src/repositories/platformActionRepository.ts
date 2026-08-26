import type { Queryable } from './types.js';

export type PlatformActionRow = {
  id: string; businessId: string; type: string; payload: Record<string, unknown>;
  requestedByKind: 'AGENT' | 'USER' | 'SYSTEM'; requestedById: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; approvalRequired: boolean;
  approvalStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  status: 'PENDING_POLICY' | 'PENDING_APPROVAL' | 'READY' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  idempotencyKey: string; correlationId: string; createdAt: Date; updatedAt: Date;
};

export type PlatformApprovalRow = {
  id: string; actionRequestId: string; businessId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  approverUserId: string | null; decisionReason: string | null; createdAt: Date; decidedAt: Date | null;
};

const ACTION_COLUMNS = `id,business_id AS "businessId",type,payload,requested_by_kind AS "requestedByKind",requested_by_id AS "requestedById",risk_level AS "riskLevel",approval_required AS "approvalRequired",approval_status AS "approvalStatus",status,idempotency_key AS "idempotencyKey",correlation_id AS "correlationId",created_at AS "createdAt",updated_at AS "updatedAt"`;
const APPROVAL_COLUMNS = `id,action_request_id AS "actionRequestId",business_id AS "businessId",status,approver_user_id AS "approverUserId",decision_reason AS "decisionReason",created_at AS "createdAt",decided_at AS "decidedAt"`;

export class PlatformActionRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: Omit<PlatformActionRow, 'createdAt' | 'updatedAt'>): Promise<PlatformActionRow> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `INSERT INTO platform_action_requests (id,business_id,type,payload,requested_by_kind,requested_by_id,risk_level,approval_required,approval_status,status,idempotency_key,correlation_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (business_id,idempotency_key) DO UPDATE SET id = platform_action_requests.id
       RETURNING ${ACTION_COLUMNS}`,
      [input.id,input.businessId,input.type,JSON.stringify(input.payload),input.requestedByKind,input.requestedById,input.riskLevel,input.approvalRequired,input.approvalStatus,input.status,input.idempotencyKey,input.correlationId],
    );
    if (!rows[0]) throw new Error('platform action insert returned no row');
    return rows[0];
  }

  async getById(businessId: string, actionId: string): Promise<PlatformActionRow | null> {
    const { rows } = await this.db.query<PlatformActionRow>(`SELECT ${ACTION_COLUMNS} FROM platform_action_requests WHERE business_id = $1 AND id = $2`, [businessId, actionId]);
    return rows[0] ?? null;
  }

  async getByIdempotencyKey(businessId: string, idempotencyKey: string): Promise<PlatformActionRow | null> {
    const { rows } = await this.db.query<PlatformActionRow>(`SELECT ${ACTION_COLUMNS} FROM platform_action_requests WHERE business_id = $1 AND idempotency_key = $2`, [businessId, idempotencyKey]);
    return rows[0] ?? null;
  }

  async updateState(businessId: string, actionId: string, input: { status?: PlatformActionRow['status'] | undefined; approvalStatus?: PlatformActionRow['approvalStatus'] | undefined }): Promise<PlatformActionRow | null> {
    const { rows } = await this.db.query<PlatformActionRow>(`UPDATE platform_action_requests SET status = COALESCE($3,status), approval_status = COALESCE($4,approval_status) WHERE business_id = $1 AND id = $2 RETURNING ${ACTION_COLUMNS}`, [businessId, actionId, input.status ?? null, input.approvalStatus ?? null]);
    return rows[0] ?? null;
  }

  async createApproval(input: { id: string; actionRequestId: string; businessId: string }): Promise<PlatformApprovalRow> {
    const { rows } = await this.db.query<PlatformApprovalRow>(`INSERT INTO platform_approvals (id,action_request_id,business_id,status) VALUES ($1,$2,$3,'PENDING') ON CONFLICT (business_id,action_request_id) DO NOTHING RETURNING ${APPROVAL_COLUMNS}`, [input.id,input.actionRequestId,input.businessId]);
    if (!rows[0]) {
      const existing = await this.getApprovalByAction(input.businessId, input.actionRequestId);
      if (!existing) throw new Error('platform approval insert returned no row');
      return existing;
    }
    return rows[0];
  }

  async getApprovalByAction(businessId: string, actionId: string): Promise<PlatformApprovalRow | null> {
    const { rows } = await this.db.query<PlatformApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM platform_approvals WHERE business_id = $1 AND action_request_id = $2`, [businessId, actionId]);
    return rows[0] ?? null;
  }

  async decideApproval(businessId: string, actionId: string, userId: string, status: 'APPROVED' | 'REJECTED', reason?: string | undefined): Promise<PlatformApprovalRow | null> {
    const { rows } = await this.db.query<PlatformApprovalRow>(`UPDATE platform_approvals SET status = $3, approver_user_id = $4, decision_reason = $5, decided_at = NOW() WHERE business_id = $1 AND action_request_id = $2 AND status = 'PENDING' RETURNING ${APPROVAL_COLUMNS}`, [businessId, actionId, status, userId, reason ?? null]);
    return rows[0] ?? null;
  }

  async listPendingApprovals(businessId: string): Promise<PlatformActionRow[]> {
    const { rows } = await this.db.query<PlatformActionRow>(`SELECT ${ACTION_COLUMNS} FROM platform_action_requests WHERE business_id = $1 AND approval_status = 'PENDING' AND status = 'PENDING_APPROVAL' ORDER BY created_at ASC`, [businessId]);
    return rows;
  }
}
