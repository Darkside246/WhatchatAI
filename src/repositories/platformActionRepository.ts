import type { Queryable } from './types.js';

export type PlatformActionRow = {
  id: string; businessId: string; type: string; payload: Record<string, unknown>;
  requestedByKind: 'AGENT' | 'USER' | 'SYSTEM'; requestedById: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; approvalRequired: boolean;
  approvalStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  status: 'PENDING_POLICY' | 'PENDING_APPROVAL' | 'READY' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  idempotencyKey: string; correlationId: string;
  executionResult: Record<string, unknown> | null;
  executionError: string | null;
  createdAt: Date; updatedAt: Date;
};

export type PlatformApprovalRow = {
  id: string; actionRequestId: string; businessId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  approverUserId: string | null; decisionReason: string | null; createdAt: Date; decidedAt: Date | null;
};

const ACTION_COLUMNS = `id,business_id AS "businessId",type,payload,requested_by_kind AS "requestedByKind",requested_by_id AS "requestedById",risk_level AS "riskLevel",approval_required AS "approvalRequired",approval_status AS "approvalStatus",status,idempotency_key AS "idempotencyKey",correlation_id AS "correlationId",execution_result AS "executionResult",execution_error AS "executionError",created_at AS "createdAt",updated_at AS "updatedAt"`;
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

  /**
   * The most recent still-open action of a given type for a given
   * conversation, if one exists - "open" meaning not yet resolved one way
   * or another (still PENDING_POLICY/PENDING_APPROVAL, or approved and
   * READY/EXECUTING but not yet SUCCEEDED/FAILED/CANCELLED). Used to stop a
   * repeated triage on the same unresolved issue (e.g. a tenant asking "is
   * anyone coming?" three times) from creating three separate duplicate
   * ActionRequests and approval prompts - each triage call should check
   * this first and reuse what's already open instead of creating another.
   */
  async findOpenByConversation(businessId: string, conversationId: string, type: string): Promise<PlatformActionRow | null> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `SELECT ${ACTION_COLUMNS} FROM platform_action_requests
        WHERE business_id = $1 AND type = $2 AND payload->>'conversationId' = $3
          AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')
        ORDER BY created_at DESC LIMIT 1`,
      [businessId, type, conversationId],
    );
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

  /**
   * Section 48 (Autonomous Morning Briefing): every real action this
   * business's agents completed or failed since a given point in time -
   * the raw material for "what did Aura do while I was asleep", never a
   * fabricated activity summary. `statuses` lets the caller ask for
   * SUCCEEDED and FAILED separately rather than filtering client-side.
   */
  async listByStatusSince(businessId: string, statuses: PlatformActionRow['status'][], sinceIso: string, limit = 50): Promise<PlatformActionRow[]> {
    const { rows } = await this.db.query<PlatformActionRow>(
      `SELECT ${ACTION_COLUMNS} FROM platform_action_requests
       WHERE business_id = $1 AND status = ANY($2::text[]) AND updated_at >= $3
       ORDER BY updated_at DESC LIMIT $4`,
      [businessId, statuses, sinceIso, limit],
    );
    return rows;
  }

  /**
   * The most recent real, decided (APPROVED/REJECTED) approvals a given
   * agent's own action requests received, most-recent-first - the raw
   * material "learning from approval patterns" is built on. Capped at
   * `limit` so a fluke of 2-3 approvals never looks like a pattern; the
   * caller decides how many real decisions must exist before it counts.
   */
  async getRecentDecisionsForAgent(businessId: string, agentId: string, limit: number): Promise<{ status: 'APPROVED' | 'REJECTED'; decidedAt: Date }[]> {
    const { rows } = await this.db.query<{ status: 'APPROVED' | 'REJECTED'; decidedAt: Date }>(
      `SELECT pap.status, pap.decided_at AS "decidedAt"
         FROM platform_approvals pap
         JOIN platform_action_requests par ON par.id = pap.action_request_id AND par.business_id = pap.business_id
        WHERE pap.business_id = $1
          AND par.requested_by_kind = 'AGENT' AND par.requested_by_id = $2
          AND pap.status IN ('APPROVED','REJECTED')
        ORDER BY pap.decided_at DESC
        LIMIT $3`,
      [businessId, agentId, limit],
    );
    return rows;
  }

  /**
   * Section 99-101 (performance): the same real "most recent N decisions"
   * query getRecentDecisionsForAgent runs, but for every candidate agent
   * in one round trip instead of one query per agent - workspaceService.ts's
   * getApprovalPatternSuggestions() used to call the singular version once
   * per agent (parallelized via Promise.all, so never a correctness bug,
   * just N real round trips on every dashboard/next-best-actions load for
   * a business with N agents). ROW_NUMBER() PARTITION BY agent gives each
   * agent its own independently-ranked "most recent decisions" window in
   * a single query.
   */
  async getRecentDecisionsForAgents(
    businessId: string,
    agentIds: string[],
    limit: number,
  ): Promise<Map<string, { status: 'APPROVED' | 'REJECTED'; decidedAt: Date }[]>> {
    const byAgent = new Map<string, { status: 'APPROVED' | 'REJECTED'; decidedAt: Date }[]>();
    if (agentIds.length === 0) return byAgent;

    const { rows } = await this.db.query<{ agentId: string; status: 'APPROVED' | 'REJECTED'; decidedAt: Date }>(
      `SELECT agent_id AS "agentId", status, "decidedAt" FROM (
         SELECT par.requested_by_id AS agent_id, pap.status, pap.decided_at AS "decidedAt",
                ROW_NUMBER() OVER (PARTITION BY par.requested_by_id ORDER BY pap.decided_at DESC) AS rn
           FROM platform_approvals pap
           JOIN platform_action_requests par ON par.id = pap.action_request_id AND par.business_id = pap.business_id
          WHERE pap.business_id = $1
            AND par.requested_by_kind = 'AGENT' AND par.requested_by_id = ANY($2::text[])
            AND pap.status IN ('APPROVED','REJECTED')
       ) ranked
       WHERE rn <= $3
       ORDER BY agent_id, "decidedAt" DESC`,
      [businessId, agentIds, limit],
    );

    for (const agentId of agentIds) byAgent.set(agentId, []);
    for (const row of rows) byAgent.get(row.agentId)?.push({ status: row.status, decidedAt: row.decidedAt });
    return byAgent;
  }

  async updateExecution(businessId: string, idempotencyKey: string, status: 'SUCCEEDED' | 'FAILED', result: unknown, error: string | undefined): Promise<void> {
    await this.db.query(
      `UPDATE platform_action_requests SET status = $3, execution_result = $4::jsonb, execution_error = $5 WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, idempotencyKey, status, result !== undefined ? JSON.stringify(result) : null, error ?? null],
    );
  }
}
