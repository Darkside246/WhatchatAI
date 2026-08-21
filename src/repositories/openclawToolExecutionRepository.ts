import type { Queryable } from './types.js';

export interface OpenClawToolExecutionRecord {
  id: string;
  businessId: string;
  fleetCellId: string;
  toolName: string;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  requestedFields: Record<string, unknown>;
  outcome: 'APPROVED' | 'DENIED';
  denialReason: string | null;
  result: unknown;
  createdAt: string;
}

interface OpenClawToolExecutionRow {
  id: string;
  business_id: string;
  fleet_cell_id: string;
  tool_name: string;
  entity_type: string;
  entity_id: string;
  idempotency_key: string;
  requested_fields: Record<string, unknown>;
  outcome: 'APPROVED' | 'DENIED';
  denial_reason: string | null;
  result: unknown;
  created_at: string;
}

function toRecord(row: OpenClawToolExecutionRow): OpenClawToolExecutionRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    fleetCellId: row.fleet_cell_id,
    toolName: row.tool_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    idempotencyKey: row.idempotency_key,
    requestedFields: row.requested_fields,
    outcome: row.outcome,
    denialReason: row.denial_reason,
    result: row.result,
    createdAt: row.created_at,
  };
}

export interface RecordExecutionInput {
  businessId: string;
  fleetCellId: string;
  toolName: string;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  requestedFields: Record<string, unknown>;
  outcome: 'APPROVED' | 'DENIED';
  denialReason?: string | null | undefined;
  result?: unknown;
}

export class OpenClawToolExecutionRepository {
  constructor(private readonly db: Queryable) {}

  /** The real idempotency lookup - a prior execution (approved OR denied) for this exact key is returned as-is, never re-decided. */
  async findByIdempotencyKey(businessId: string, toolName: string, idempotencyKey: string): Promise<OpenClawToolExecutionRecord | null> {
    const { rows } = await this.db.query<OpenClawToolExecutionRow>(
      'SELECT * FROM openclaw_tool_executions WHERE business_id = $1 AND tool_name = $2 AND idempotency_key = $3',
      [businessId, toolName, idempotencyKey],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async record(input: RecordExecutionInput): Promise<OpenClawToolExecutionRecord> {
    const { rows } = await this.db.query<OpenClawToolExecutionRow>(
      `INSERT INTO openclaw_tool_executions
         (business_id, fleet_cell_id, tool_name, entity_type, entity_id, idempotency_key, requested_fields, outcome, denial_reason, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.businessId,
        input.fleetCellId,
        input.toolName,
        input.entityType,
        input.entityId,
        input.idempotencyKey,
        JSON.stringify(input.requestedFields),
        input.outcome,
        input.denialReason ?? null,
        input.result === undefined ? null : JSON.stringify(input.result),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('openclaw_tool_executions insert returned no row');
    return toRecord(row);
  }

  /** Count of invocations (any outcome) for this business+tool within the window - the gateway's own rate limit. */
  async countRecent(businessId: string, toolName: string, windowMinutes: number): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM openclaw_tool_executions
       WHERE business_id = $1 AND tool_name = $2 AND created_at > now() - ($3 || ' minutes')::interval`,
      [businessId, toolName, windowMinutes],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
