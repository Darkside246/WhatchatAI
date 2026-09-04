import type { Queryable } from './types.js';

export type AgentWorkJournalEntryType = 'FINDING' | 'ACTION_TAKEN' | 'QUEUED_FOR_APPROVAL' | 'SKIPPED';

export interface AgentWorkJournalRecord {
  id: string;
  businessId: string;
  agentId: string | null;
  occurredAt: string;
  entryType: AgentWorkJournalEntryType;
  summary: string;
  detail: Record<string, unknown>;
}

interface AgentWorkJournalRow {
  id: string;
  business_id: string;
  agent_id: string | null;
  occurred_at: string;
  entry_type: AgentWorkJournalEntryType;
  summary: string;
  detail: Record<string, unknown>;
}

function toRecord(row: AgentWorkJournalRow): AgentWorkJournalRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    agentId: row.agent_id,
    occurredAt: row.occurred_at,
    entryType: row.entry_type,
    summary: row.summary,
    detail: row.detail,
  };
}

/**
 * Section 41-42 Phase 1's real work journal (migration 979) - what the
 * autonomous sweep found and did, backing the Morning Briefing's "While
 * You Were Away" section and a plain audit trail. Append-only: no update
 * or delete method exists because nothing in this feature ever needs to
 * change a past entry.
 */
export class AgentWorkJournalRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: { businessId: string; agentId: string | null; entryType: AgentWorkJournalEntryType; summary: string; detail?: Record<string, unknown> }): Promise<AgentWorkJournalRecord> {
    const { rows } = await this.db.query<AgentWorkJournalRow>(
      `INSERT INTO agent_work_journal (business_id, agent_id, entry_type, summary, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [input.businessId, input.agentId, input.entryType, input.summary, JSON.stringify(input.detail ?? {})],
    );
    const row = rows[0];
    if (!row) throw new Error('agent_work_journal insert returned no row');
    return toRecord(row);
  }

  async listSince(businessId: string, sinceIso: string, limit = 500): Promise<AgentWorkJournalRecord[]> {
    const { rows } = await this.db.query<AgentWorkJournalRow>(
      `SELECT * FROM agent_work_journal WHERE business_id = $1 AND occurred_at >= $2 ORDER BY occurred_at DESC LIMIT $3`,
      [businessId, sinceIso, limit],
    );
    return rows.map(toRecord);
  }

  /** Real counts per entry_type since a point in time - the "While You Were Away" summary's own data, never a fabricated estimate. */
  async countByTypeSince(businessId: string, sinceIso: string): Promise<Record<AgentWorkJournalEntryType, number>> {
    const { rows } = await this.db.query<{ entry_type: AgentWorkJournalEntryType; count: string }>(
      `SELECT entry_type, count(*)::text AS count FROM agent_work_journal WHERE business_id = $1 AND occurred_at >= $2 GROUP BY entry_type`,
      [businessId, sinceIso],
    );
    const counts: Record<AgentWorkJournalEntryType, number> = { FINDING: 0, ACTION_TAKEN: 0, QUEUED_FOR_APPROVAL: 0, SKIPPED: 0 };
    for (const row of rows) counts[row.entry_type] = Number(row.count);
    return counts;
  }
}
