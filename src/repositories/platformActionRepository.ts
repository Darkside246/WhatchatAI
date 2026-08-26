import type { Queryable } from './types.js';

export type PlatformActionRow = {
  id: string;
  businessId: string;
  type: string;
  payload: Record<string, unknown>;
  requestedByKind: 'AGENT' | 'USER' | 'SYSTEM';
  requestedById: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  approvalRequired: boolean;
  approvalStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  status: 'PENDING_POLICY' | 'PENDING_APPROVAL' | 'READY' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  idempotencyKey: string;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
};

export class PlatformActionRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: Omit<PlatformActionRow, 'createdAt' | 'updatedAt'>): Promise<PlatformActionRow> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `INSERT INTO platform_action_requests
       (id,business_id,type,payload,requested_by_kind,requested_by_id,risk_level,approval_required,approval_status,status,idempotency_key,correlation_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (business_id,idempotency_key) DO UPDATE SET id = platform_action_requests.id
       RETURNING id,business_id AS "businessId",type,payload,requested_by_kind AS "requestedByKind",requested_by_id AS "requestedById",risk_level AS "riskLevel",approval_required AS "approvalRequired",approval_status AS "approvalStatus",status,idempotency_key AS "idempotencyKey",correlation_id AS "correlationId",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [input.id,input.businessId,input.type,JSON.stringify(input.payload),input.requestedByKind,input.requestedById,input.riskLevel,input.approvalRequired,input.approvalStatus,input.status,input.idempotencyKey,input.correlationId],
    );
    if (!rows[0]) throw new Error('platform action insert returned no row');
    return { ...rows[0], payload: rows[0].payload && typeof rows[0].payload === 'object' && !Array.isArray(rows[0].payload) ? rows[0].payload : {} };
  }

  async getByIdempotencyKey(businessId: string, idempotencyKey: string): Promise<PlatformActionRow | null> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `SELECT id,business_id AS "businessId",type,payload,requested_by_kind AS "requestedByKind",requested_by_id AS "requestedById",risk_level AS "riskLevel",approval_required AS "approvalRequired",approval_status AS "approvalStatus",status,idempotency_key AS "idempotencyKey",correlation_id AS "correlationId",created_at AS "createdAt",updated_at AS "updatedAt"
       FROM platform_action_requests WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async updateState(businessId: string, actionId: string, input: { status?: PlatformActionRow['status']; approvalStatus?: PlatformActionRow['approvalStatus'] }): Promise<PlatformActionRow | null> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `UPDATE platform_action_requests SET
         status = COALESCE($3, status),
         approval_status = COALESCE($4, approval_status)
       WHERE business_id = $1 AND id = $2
       RETURNING id,business_id AS "businessId",type,payload,requested_by_kind AS "requestedByKind",requested_by_id AS "requestedById",risk_level AS "riskLevel",approval_required AS "approvalRequired",approval_status AS "approvalStatus",status,idempotency_key AS "idempotencyKey",correlation_id AS "correlationId",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [businessId, actionId, input.status ?? null, input.approvalStatus ?? null],
    );
    return rows[0] ?? null;
  }

  async listPendingApprovals(businessId: string): Promise<PlatformActionRow[]> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `SELECT id,business_id AS "businessId",type,payload,requested_by_kind AS "requestedByKind",requested_by_id AS "requestedById",risk_level AS "riskLevel",approval_required AS "approvalRequired",approval_status AS "approvalStatus",status,idempotency_key AS "idempotencyKey",correlation_id AS "correlationId",created_at AS "createdAt",updated_at AS "updatedAt"
       FROM platform_action_requests WHERE business_id = $1 AND approval_status = 'PENDING' AND status = 'PENDING_APPROVAL'
       ORDER BY created_at ASC`,
      [businessId],
    );
    return rows;
  }
}
