import type { Queryable } from './types.js';

export type AgentAvailability = 'available' | 'busy' | 'offline';

export interface AgentCapacityRecord {
  userId: string;
  businessId: string;
  maxActiveConversations: number;
  availability: AgentAvailability;
  createdAt: string;
  updatedAt: string;
}

interface AgentCapacityRow {
  user_id: string;
  business_id: string;
  max_active_conversations: number;
  availability: AgentAvailability;
  created_at: string;
  updated_at: string;
}

function toRecord(row: AgentCapacityRow): AgentCapacityRecord {
  return {
    userId: row.user_id,
    businessId: row.business_id,
    maxActiveConversations: row.max_active_conversations,
    availability: row.availability,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEFAULT_MAX_ACTIVE_CONVERSATIONS = 20;

export class AgentCapacityRepository {
  constructor(private readonly db: Queryable) {}

  async ensureDefault(businessId: string, userId: string): Promise<AgentCapacityRecord> {
    const { rows } = await this.db.query<AgentCapacityRow>(
      `INSERT INTO agent_capacity (user_id, business_id, max_active_conversations)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [userId, businessId, DEFAULT_MAX_ACTIVE_CONVERSATIONS],
    );
    const row = rows[0];
    if (!row) throw new Error('agent_capacity insert returned no row');
    return toRecord(row);
  }

  async findByUser(userId: string): Promise<AgentCapacityRecord | null> {
    const { rows } = await this.db.query<AgentCapacityRow>('SELECT * FROM agent_capacity WHERE user_id = $1', [userId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<AgentCapacityRecord[]> {
    const { rows } = await this.db.query<AgentCapacityRow>('SELECT * FROM agent_capacity WHERE business_id = $1', [businessId]);
    return rows.map(toRecord);
  }

  async update(
    userId: string,
    input: { maxActiveConversations?: number | undefined; availability?: AgentAvailability | undefined },
  ): Promise<AgentCapacityRecord | null> {
    const { rows } = await this.db.query<AgentCapacityRow>(
      `UPDATE agent_capacity
       SET max_active_conversations = COALESCE($2, max_active_conversations),
           availability = COALESCE($3, availability),
           updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
      [userId, input.maxActiveConversations ?? null, input.availability ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
