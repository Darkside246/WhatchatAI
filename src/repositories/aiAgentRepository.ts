import type { Queryable } from './types.js';
import type { AgentStatus } from '../domain/platform/types.js';

export interface AiAgentRecord {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  persona: string | null;
  tone: string | null;
  language: string | null;
  systemInstruction: string | null;
  greeting: string | null;
  businessContext: string | null;
  responseStyle: string | null;
  humanTakeoverPolicy: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface AiAgentRow {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  persona: string | null;
  tone: string | null;
  language: string | null;
  system_instruction: string | null;
  greeting: string | null;
  business_context: string | null;
  response_style: string | null;
  human_takeover_policy: string | null;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: AiAgentRow): AiAgentRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    persona: row.persona,
    tone: row.tone,
    language: row.language,
    systemInstruction: row.system_instruction,
    greeting: row.greeting,
    businessContext: row.business_context,
    responseStyle: row.response_style,
    humanTakeoverPolicy: row.human_takeover_policy,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface CreateAiAgentInput {
  businessId: string;
  name: string;
  description?: string | null | undefined;
  persona?: string | null | undefined;
  tone?: string | null | undefined;
  language?: string | null | undefined;
  systemInstruction?: string | null | undefined;
  greeting?: string | null | undefined;
  businessContext?: string | null | undefined;
  responseStyle?: string | null | undefined;
  humanTakeoverPolicy?: string | null | undefined;
}

export class AiAgentRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateAiAgentInput): Promise<AiAgentRecord> {
    const { rows } = await this.db.query<AiAgentRow>(
      `INSERT INTO ai_agents
         (business_id, name, description, persona, tone, language, system_instruction,
          greeting, business_context, response_style, human_takeover_policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.businessId,
        input.name,
        input.description ?? null,
        input.persona ?? null,
        input.tone ?? null,
        input.language ?? null,
        input.systemInstruction ?? null,
        input.greeting ?? null,
        input.businessContext ?? null,
        input.responseStyle ?? null,
        input.humanTakeoverPolicy ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_agents insert returned no row');
    return toRecord(row);
  }

  async findById(id: string): Promise<AiAgentRecord | null> {
    const { rows } = await this.db.query<AiAgentRow>('SELECT * FROM ai_agents WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * No agent-to-conversation routing exists yet (see migration 022's own
   * comment) - single-agent-per-business is the honest v1 scope, so the
   * most recently created ACTIVE agent is the one used for every AI-driven
   * chat in the business. Returns null (never a fabricated default) when
   * the business has no active agent configured.
   */
  async findActiveForBusiness(businessId: string): Promise<AiAgentRecord | null> {
    const { rows } = await this.db.query<AiAgentRow>(
      `SELECT * FROM ai_agents WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByBusiness(businessId: string): Promise<AiAgentRecord[]> {
    const { rows } = await this.db.query<AiAgentRow>(
      'SELECT * FROM ai_agents WHERE business_id = $1 AND deleted_at IS NULL ORDER BY created_at',
      [businessId],
    );
    return rows.map(toRecord);
  }

  /** Only ACTIVE/PAUSED agents count against the plan limit - ARCHIVED ones don't. */
  async countActiveByBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM ai_agents
       WHERE business_id = $1 AND deleted_at IS NULL AND status IN ('ACTIVE', 'PAUSED')`,
      [businessId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async updateStatus(id: string, status: AgentStatus): Promise<void> {
    await this.db.query('UPDATE ai_agents SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  }
}
