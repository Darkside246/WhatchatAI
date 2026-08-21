import type { Queryable } from './types.js';

export type PromptOptimizationStatus = 'pending_review' | 'approved' | 'rejected';

export interface AiAgentPromptOptimizationRecord {
  id: string;
  businessId: string;
  agentId: string;
  source: 'dspy';
  status: PromptOptimizationStatus;
  baselineInstruction: string | null;
  optimizedInstruction: string;
  metricName: string | null;
  metricScore: number | null;
  datasetSummary: Record<string, unknown>;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
}

interface AiAgentPromptOptimizationRow {
  id: string;
  business_id: string;
  agent_id: string;
  source: 'dspy';
  status: PromptOptimizationStatus;
  baseline_instruction: string | null;
  optimized_instruction: string;
  metric_name: string | null;
  metric_score: number | null;
  dataset_summary: Record<string, unknown>;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
}

function toRecord(row: AiAgentPromptOptimizationRow): AiAgentPromptOptimizationRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    agentId: row.agent_id,
    source: row.source,
    status: row.status,
    baselineInstruction: row.baseline_instruction,
    optimizedInstruction: row.optimized_instruction,
    metricName: row.metric_name,
    metricScore: row.metric_score === null ? null : Number(row.metric_score),
    datasetSummary: row.dataset_summary ?? {},
    createdAt: row.created_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
  };
}

export interface CreatePromptOptimizationInput {
  businessId: string;
  agentId: string;
  baselineInstruction: string | null;
  optimizedInstruction: string;
  metricName?: string | null;
  metricScore?: number | null;
  datasetSummary?: Record<string, unknown>;
}

export class AiAgentPromptOptimizationRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreatePromptOptimizationInput): Promise<AiAgentPromptOptimizationRecord> {
    const { rows } = await this.db.query<AiAgentPromptOptimizationRow>(
      `INSERT INTO ai_agent_prompt_optimizations
         (business_id, agent_id, baseline_instruction, optimized_instruction, metric_name, metric_score, dataset_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.businessId,
        input.agentId,
        input.baselineInstruction,
        input.optimizedInstruction,
        input.metricName ?? null,
        input.metricScore ?? null,
        JSON.stringify(input.datasetSummary ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_agent_prompt_optimizations insert returned no row');
    return toRecord(row);
  }

  async findByIdForAgent(businessId: string, agentId: string, id: string): Promise<AiAgentPromptOptimizationRecord | null> {
    const { rows } = await this.db.query<AiAgentPromptOptimizationRow>(
      'SELECT * FROM ai_agent_prompt_optimizations WHERE id = $1 AND business_id = $2 AND agent_id = $3',
      [id, businessId, agentId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByAgent(businessId: string, agentId: string): Promise<AiAgentPromptOptimizationRecord[]> {
    const { rows } = await this.db.query<AiAgentPromptOptimizationRow>(
      'SELECT * FROM ai_agent_prompt_optimizations WHERE business_id = $1 AND agent_id = $2 ORDER BY created_at DESC',
      [businessId, agentId],
    );
    return rows.map(toRecord);
  }

  /** Only ever transitions a row still 'pending_review' - an already-decided row can never be re-decided. */
  async markApproved(id: string, reviewedBy: string): Promise<AiAgentPromptOptimizationRecord | null> {
    const { rows } = await this.db.query<AiAgentPromptOptimizationRow>(
      `UPDATE ai_agent_prompt_optimizations
       SET status = 'approved', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1 AND status = 'pending_review'
       RETURNING *`,
      [id, reviewedBy],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markRejected(id: string, reviewedBy: string, reason: string | null): Promise<AiAgentPromptOptimizationRecord | null> {
    const { rows } = await this.db.query<AiAgentPromptOptimizationRow>(
      `UPDATE ai_agent_prompt_optimizations
       SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), rejection_reason = $3
       WHERE id = $1 AND status = 'pending_review'
       RETURNING *`,
      [id, reviewedBy, reason],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
