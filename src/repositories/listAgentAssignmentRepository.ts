import type { Queryable } from './types.js';
import { AiAgentRepository } from './aiAgentRepository.js';

export interface ListAgentAssignmentRecord {
  id: string;
  businessId: string;
  listId: string;
  agentId: string;
  enabled: boolean;
  useConversationHistory: boolean;
  useLearnProfile: boolean;
  rememberListSpecificInfo: boolean;
  requireApproval: boolean;
  /** Restrict-only override of the agent's own autonomyLevel - null means "no override, use the agent's own level unchanged". Never greater than the agent's own autonomyLevel; enforced on every write in upsert() below. */
  autonomyOverride: number | null;
  createdAt: string;
  updatedAt: string;
}

interface ListAgentAssignmentRow {
  id: string;
  business_id: string;
  list_id: string;
  agent_id: string;
  enabled: boolean;
  use_conversation_history: boolean;
  use_learn_profile: boolean;
  remember_list_specific_info: boolean;
  require_approval: boolean;
  autonomy_override: number | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ListAgentAssignmentRow): ListAgentAssignmentRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    listId: row.list_id,
    agentId: row.agent_id,
    enabled: row.enabled,
    useConversationHistory: row.use_conversation_history,
    useLearnProfile: row.use_learn_profile,
    rememberListSpecificInfo: row.remember_list_specific_info,
    requireApproval: row.require_approval,
    autonomyOverride: row.autonomy_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertListAgentAssignmentInput {
  businessId: string;
  listId: string;
  agentId: string;
  enabled?: boolean | undefined;
  useConversationHistory?: boolean | undefined;
  useLearnProfile?: boolean | undefined;
  rememberListSpecificInfo?: boolean | undefined;
  requireApproval?: boolean | undefined;
  autonomyOverride?: number | null | undefined;
}

/** Thrown when a caller attempts to set autonomyOverride higher than the agent's own autonomyLevel - a List may only ever make an agent MORE conservative, never less ("never silently increase autonomy"). */
export class AutonomyOverrideExceedsAgentError extends Error {}

/**
 * AURA Lists (Phase 1): one row per (list, agent). Mirrors
 * writing_twin_agent_access's own fail-closed shape - no row means no
 * assignment, findEnabledForList only ever returns an enabled=true row.
 * RLS'd (migration 997) - always construct with queryAsTenant(businessId).
 */
export class ListAgentAssignmentRepository {
  constructor(private readonly db: Queryable) {}

  async findEnabledForList(businessId: string, listId: string): Promise<ListAgentAssignmentRecord | null> {
    const { rows } = await this.db.query<ListAgentAssignmentRow>(
      `SELECT * FROM list_agent_assignments WHERE business_id = $1 AND list_id = $2 AND enabled = true LIMIT 1`,
      [businessId, listId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForList(businessId: string, listId: string): Promise<ListAgentAssignmentRecord[]> {
    const { rows } = await this.db.query<ListAgentAssignmentRow>(
      `SELECT * FROM list_agent_assignments WHERE business_id = $1 AND list_id = $2 ORDER BY created_at ASC`,
      [businessId, listId],
    );
    return rows.map(toRecord);
  }

  /**
   * Upserts one (list, agent) assignment. If autonomyOverride is provided
   * (and non-null), it is validated against the agent's own current
   * autonomyLevel first - this is the real enforcement point for
   * restrict-only; the DB CHECK constraint only bounds the value to 1-5,
   * it cannot see ai_agents.autonomy_level.
   */
  async upsert(input: UpsertListAgentAssignmentInput): Promise<ListAgentAssignmentRecord> {
    if (input.autonomyOverride != null) {
      const agentRepository = new AiAgentRepository(this.db);
      const agent = await agentRepository.findByIdForBusiness(input.agentId, input.businessId);
      if (agent && input.autonomyOverride > agent.autonomyLevel) {
        throw new AutonomyOverrideExceedsAgentError(
          `autonomyOverride (${input.autonomyOverride}) may not exceed agent "${agent.name}"'s own autonomyLevel (${agent.autonomyLevel})`,
        );
      }
    }

    // autonomyOverride needs a "was this field actually provided" flag,
    // unlike the plain booleans above - null is a legitimate explicit value
    // (clear the override), so a bare COALESCE against undefined-as-null
    // would silently wipe out a previously-set override on any unrelated
    // patch (e.g. just toggling `enabled`). Same CASE-WHEN-touched idiom
    // customerMemoryRepository.update uses for preferredName.
    const autonomyOverrideTouched = input.autonomyOverride !== undefined;

    const { rows } = await this.db.query<ListAgentAssignmentRow>(
      `INSERT INTO list_agent_assignments
         (business_id, list_id, agent_id, enabled, use_conversation_history, use_learn_profile, remember_list_specific_info, require_approval, autonomy_override)
       VALUES ($1, $2, $3, COALESCE($4, true), COALESCE($5, true), COALESCE($6, true), COALESCE($7, true), COALESCE($8, false), $9)
       ON CONFLICT (list_id, agent_id) DO UPDATE SET
         enabled = COALESCE($4, list_agent_assignments.enabled),
         use_conversation_history = COALESCE($5, list_agent_assignments.use_conversation_history),
         use_learn_profile = COALESCE($6, list_agent_assignments.use_learn_profile),
         remember_list_specific_info = COALESCE($7, list_agent_assignments.remember_list_specific_info),
         require_approval = COALESCE($8, list_agent_assignments.require_approval),
         autonomy_override = CASE WHEN $10 THEN $9 ELSE list_agent_assignments.autonomy_override END,
         updated_at = now()
       RETURNING *`,
      [
        input.businessId, input.listId, input.agentId,
        input.enabled ?? null, input.useConversationHistory ?? null, input.useLearnProfile ?? null,
        input.rememberListSpecificInfo ?? null, input.requireApproval ?? null, input.autonomyOverride ?? null,
        autonomyOverrideTouched,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('list_agent_assignments upsert returned no row');
    return toRecord(row);
  }

  async remove(businessId: string, listId: string, agentId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM list_agent_assignments WHERE business_id = $1 AND list_id = $2 AND agent_id = $3`,
      [businessId, listId, agentId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
