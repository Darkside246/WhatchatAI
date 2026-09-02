import type { Queryable } from './types.js';
import type { AgentStatus } from '../domain/platform/types.js';

/** Mirrors the real CHECK constraint on ai_agents.category (migration 042). */
export const AGENT_CATEGORIES = [
  'general', 'sales', 'support', 'billing', 'bookings', 'logistics',
  'plumbing', 'electrical', 'mechanical', 'hvac', 'construction',
  'cleaning', 'landscaping', 'it_services', 'beauty', 'hospitality',
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/**
 * Categories covering regulated or physically hazardous trades. An agent in
 * one of these handles the BUSINESS side only - booking, quoting, job status,
 * dispatch - and is explicitly barred from giving technical or safety advice
 * (see buildSystemInstruction in aiReplyService).
 */
export const ADVICE_RESTRICTED_CATEGORIES: readonly AgentCategory[] = [
  'plumbing', 'electrical', 'mechanical', 'hvac', 'construction', 'it_services',
];

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
  category: AgentCategory;
  specialization: string | null;
  triggerKeywords: string[];
  blockedKeywords: string[];
  /** Real facts (names, school, address, etc.) that must never appear in an AI-generated reply - enforced by outboundLeakGuard.ts, not just a prompt instruction. */
  protectedFacts: string[];
  /** Sent to the customer when the Outbound Leak Guard blocks a reply. Null means "use the built-in default" (see incomingMessagesWorker.ts). */
  blockedReplyMessage: string | null;
  responseDelaySeconds: number;
  parentAgentId: string | null;
  escalateToAgentId: string | null;
  priority: number;
  /** Real operator-chosen canvas coordinates. Null until they actually place it. */
  canvasX: number | null;
  canvasY: number | null;
  /**
   * The tool this agent may call, when allowedToolsEnabled is true - a real
   * restriction enforced in aiReplyService.ts's buildReplyTools, not just
   * UI decoration. When allowedToolsEnabled is false (every pre-existing
   * agent, and the default for a new one), this list is ignored and every
   * connection-eligible tool is offered, unchanged from behavior before
   * this column existed.
   */
  allowedTools: string[];
  /** Always enforced, regardless of allowedToolsEnabled - a real hard block. */
  forbiddenTools: string[];
  allowedToolsEnabled: boolean;
  /**
   * A real, simple "ask before acting" toggle (migration 955) - not a
   * graduated autonomy ladder. When true, a SEND-tier tool call creates a
   * pending action in the real approval queue instead of executing
   * immediately (see aiReplyService.ts's createPendingMeetingApproval).
   */
  requiresApprovalForActions: boolean;
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
  category: AgentCategory;
  specialization: string | null;
  trigger_keywords: string[];
  blocked_keywords: string[];
  protected_facts: string[];
  blocked_reply_message: string | null;
  response_delay_seconds: number;
  parent_agent_id: string | null;
  escalate_to_agent_id: string | null;
  priority: number;
  canvas_x: number | null;
  canvas_y: number | null;
  allowed_tools: string[];
  forbidden_tools: string[];
  allowed_tools_enabled: boolean;
  requires_approval_for_actions: boolean;
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
    category: row.category,
    specialization: row.specialization,
    triggerKeywords: row.trigger_keywords ?? [],
    blockedKeywords: row.blocked_keywords ?? [],
    protectedFacts: row.protected_facts ?? [],
    blockedReplyMessage: row.blocked_reply_message,
    responseDelaySeconds: row.response_delay_seconds,
    parentAgentId: row.parent_agent_id,
    escalateToAgentId: row.escalate_to_agent_id,
    priority: row.priority,
    canvasX: row.canvas_x === null ? null : Number(row.canvas_x),
    canvasY: row.canvas_y === null ? null : Number(row.canvas_y),
    allowedTools: row.allowed_tools ?? [],
    forbiddenTools: row.forbidden_tools ?? [],
    allowedToolsEnabled: row.allowed_tools_enabled,
    requiresApprovalForActions: row.requires_approval_for_actions,
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
  category?: AgentCategory | undefined;
  specialization?: string | null | undefined;
  triggerKeywords?: string[] | undefined;
  blockedKeywords?: string[] | undefined;
  protectedFacts?: string[] | undefined;
  blockedReplyMessage?: string | null | undefined;
  responseDelaySeconds?: number | undefined;
  parentAgentId?: string | null | undefined;
  escalateToAgentId?: string | null | undefined;
  priority?: number | undefined;
  allowedTools?: string[] | undefined;
  forbiddenTools?: string[] | undefined;
  allowedToolsEnabled?: boolean | undefined;
  requiresApprovalForActions?: boolean | undefined;
}

/** Every field an agent's owner can actually change after creation. */
export type UpdateAiAgentInput = Omit<CreateAiAgentInput, 'businessId'>;

export class AiAgentRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateAiAgentInput): Promise<AiAgentRecord> {
    const { rows } = await this.db.query<AiAgentRow>(
      `INSERT INTO ai_agents
         (business_id, name, description, persona, tone, language, system_instruction,
          greeting, business_context, response_style, human_takeover_policy,
          category, specialization, trigger_keywords, blocked_keywords, protected_facts,
          blocked_reply_message, response_delay_seconds, parent_agent_id, escalate_to_agent_id, priority,
          allowed_tools, forbidden_tools, allowed_tools_enabled, requires_approval_for_actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
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
        input.category ?? 'general',
        input.specialization ?? null,
        JSON.stringify(input.triggerKeywords ?? []),
        JSON.stringify(input.blockedKeywords ?? []),
        JSON.stringify(input.protectedFacts ?? []),
        input.blockedReplyMessage ?? null,
        input.responseDelaySeconds ?? 0,
        input.parentAgentId ?? null,
        input.escalateToAgentId ?? null,
        input.priority ?? 0,
        JSON.stringify(input.allowedTools ?? []),
        JSON.stringify(input.forbiddenTools ?? []),
        input.allowedToolsEnabled ?? false,
        input.requiresApprovalForActions ?? false,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_agents insert returned no row');
    return toRecord(row);
  }

  /**
   * A real full update of an agent's configuration. Every column here is one
   * the owner can genuinely change; status is deliberately excluded so the
   * kill switch stays its own audited, separately-permissioned action.
   */
  async update(id: string, input: UpdateAiAgentInput): Promise<AiAgentRecord | null> {
    const { rows } = await this.db.query<AiAgentRow>(
      `UPDATE ai_agents SET
         name = $2, description = $3, persona = $4, tone = $5, language = $6,
         system_instruction = $7, greeting = $8, business_context = $9,
         response_style = $10, human_takeover_policy = $11, category = $12,
         specialization = $13, trigger_keywords = $14, blocked_keywords = $15,
         protected_facts = $16, blocked_reply_message = $17, response_delay_seconds = $18,
         parent_agent_id = $19, escalate_to_agent_id = $20, priority = $21,
         allowed_tools = $22, forbidden_tools = $23, allowed_tools_enabled = $24, requires_approval_for_actions = $25, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [
        id,
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
        input.category ?? 'general',
        input.specialization ?? null,
        JSON.stringify(input.triggerKeywords ?? []),
        JSON.stringify(input.blockedKeywords ?? []),
        JSON.stringify(input.protectedFacts ?? []),
        input.blockedReplyMessage ?? null,
        input.responseDelaySeconds ?? 0,
        input.parentAgentId ?? null,
        input.escalateToAgentId ?? null,
        input.priority ?? 0,
        JSON.stringify(input.allowedTools ?? []),
        JSON.stringify(input.forbiddenTools ?? []),
        input.allowedToolsEnabled ?? false,
        input.requiresApprovalForActions ?? false,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<AiAgentRecord | null> {
    const { rows } = await this.db.query<AiAgentRow>('SELECT * FROM ai_agents WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Tenant-scoped lookup - an agent id belonging to another business
   * returns null, identically to a genuinely nonexistent id. Prefer this
   * over the bare findById() for any caller that has a businessId in scope.
   */
  async findByIdForBusiness(id: string, businessId: string): Promise<AiAgentRecord | null> {
    const { rows } = await this.db.query<AiAgentRow>(
      'SELECT * FROM ai_agents WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
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

  /** Persists a real drag on the org canvas. Position only - never touches configuration. */
  async updatePosition(id: string, x: number, y: number): Promise<void> {
    await this.db.query('UPDATE ai_agents SET canvas_x = $2, canvas_y = $3, updated_at = now() WHERE id = $1', [id, x, y]);
  }

  async updateStatus(id: string, status: AgentStatus): Promise<void> {
    await this.db.query('UPDATE ai_agents SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  }
}
