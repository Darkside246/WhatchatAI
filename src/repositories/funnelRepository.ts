import type { Queryable } from './types.js';

export const FUNNEL_NODE_TYPES = [
  'MESSAGE',
  'WAIT',
  'CONDITION',
  'ASSIGN_HUMAN',
  'ASSIGN_TEAM',
  'ADD_TAG',
  'REMOVE_TAG',
  'UPDATE_STAGE',
  'NOTIFY_USER',
] as const;
export type FunnelNodeType = (typeof FUNNEL_NODE_TYPES)[number];

export const FUNNEL_INSTANCE_STATUSES = ['ACTIVE', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type FunnelInstanceStatus = (typeof FUNNEL_INSTANCE_STATUSES)[number];

export interface FunnelDefinitionRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FunnelDefinitionRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  created_by: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function toDefinitionRecord(row: FunnelDefinitionRow): FunnelDefinitionRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    createdBy: row.created_by,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface FunnelStepRecord {
  id: string;
  funnelId: string;
  position: number;
  nodeType: FunnelNodeType;
  config: Record<string, unknown>;
  createdAt: string;
}

interface FunnelStepRow {
  id: string;
  funnel_id: string;
  position: number;
  node_type: FunnelNodeType;
  config: Record<string, unknown>;
  created_at: string;
}

function toStepRecord(row: FunnelStepRow): FunnelStepRecord {
  return { id: row.id, funnelId: row.funnel_id, position: row.position, nodeType: row.node_type, config: row.config, createdAt: row.created_at };
}

export interface FunnelInstanceRecord {
  id: string;
  funnelId: string;
  businessId: string;
  crmContactId: string;
  chatId: string;
  currentPosition: number;
  status: FunnelInstanceStatus;
  startedAt: string;
  completedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface FunnelInstanceRow {
  id: string;
  funnel_id: string;
  business_id: string;
  crm_contact_id: string;
  chat_id: string;
  current_position: number;
  status: FunnelInstanceStatus;
  started_at: string;
  completed_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function toInstanceRecord(row: FunnelInstanceRow): FunnelInstanceRecord {
  return {
    id: row.id,
    funnelId: row.funnel_id,
    businessId: row.business_id,
    crmContactId: row.crm_contact_id,
    chatId: row.chat_id,
    currentPosition: row.current_position,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export class FunnelRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { businessId: string; whatsappAccountId: string; createdBy: string; name: string; description: string | null }): Promise<FunnelDefinitionRecord> {
    const { rows } = await this.db.query<FunnelDefinitionRow>(
      `INSERT INTO funnel_definitions (business_id, whatsapp_account_id, created_by, name, description) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.businessId, input.whatsappAccountId, input.createdBy, input.name, input.description],
    );
    const row = rows[0];
    if (!row) throw new Error('funnel_definitions insert returned no row');
    return toDefinitionRecord(row);
  }

  async findByIdForBusiness(businessId: string, id: string): Promise<FunnelDefinitionRecord | null> {
    const { rows } = await this.db.query<FunnelDefinitionRow>('SELECT * FROM funnel_definitions WHERE id = $1 AND business_id = $2', [id, businessId]);
    return rows[0] ? toDefinitionRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<FunnelDefinitionRecord[]> {
    const { rows } = await this.db.query<FunnelDefinitionRow>('SELECT * FROM funnel_definitions WHERE business_id = $1 ORDER BY created_at DESC', [businessId]);
    return rows.map(toDefinitionRecord);
  }

  async setActive(id: string, isActive: boolean): Promise<FunnelDefinitionRecord | null> {
    const { rows } = await this.db.query<FunnelDefinitionRow>(
      'UPDATE funnel_definitions SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, isActive],
    );
    return rows[0] ? toDefinitionRecord(rows[0]) : null;
  }

  async updateMeta(id: string, name: string, description: string | null): Promise<FunnelDefinitionRecord | null> {
    const { rows } = await this.db.query<FunnelDefinitionRow>(
      'UPDATE funnel_definitions SET name = $2, description = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [id, name, description],
    );
    return rows[0] ? toDefinitionRecord(rows[0]) : null;
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM funnel_definitions WHERE id = $1', [id]);
  }

  async listSteps(funnelId: string): Promise<FunnelStepRecord[]> {
    const { rows } = await this.db.query<FunnelStepRow>('SELECT * FROM funnel_steps WHERE funnel_id = $1 ORDER BY position', [funnelId]);
    return rows.map(toStepRecord);
  }

  async getStepAtPosition(funnelId: string, position: number): Promise<FunnelStepRecord | null> {
    const { rows } = await this.db.query<FunnelStepRow>('SELECT * FROM funnel_steps WHERE funnel_id = $1 AND position = $2', [funnelId, position]);
    return rows[0] ? toStepRecord(rows[0]) : null;
  }

  /** Replaces the entire step list atomically - simpler and safer than incremental reorder/patch operations for a linear list. */
  async replaceSteps(funnelId: string, steps: { nodeType: FunnelNodeType; config: Record<string, unknown> }[]): Promise<FunnelStepRecord[]> {
    await this.db.query('DELETE FROM funnel_steps WHERE funnel_id = $1', [funnelId]);
    if (steps.length === 0) return [];
    const values: string[] = [];
    const params: unknown[] = [funnelId];
    steps.forEach((step, index) => {
      const base = index * 3;
      values.push(`($1, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
      params.push(index, step.nodeType, JSON.stringify(step.config));
    });
    const { rows } = await this.db.query<FunnelStepRow>(
      `INSERT INTO funnel_steps (funnel_id, position, node_type, config) VALUES ${values.join(', ')} RETURNING *`,
      params,
    );
    return rows.map(toStepRecord).sort((a, b) => a.position - b.position);
  }

  async createInstance(input: { funnelId: string; businessId: string; crmContactId: string; chatId: string }): Promise<FunnelInstanceRecord> {
    const { rows } = await this.db.query<FunnelInstanceRow>(
      `INSERT INTO funnel_instances (funnel_id, business_id, crm_contact_id, chat_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.funnelId, input.businessId, input.crmContactId, input.chatId],
    );
    const row = rows[0];
    if (!row) throw new Error('funnel_instances insert returned no row');
    return toInstanceRecord(row);
  }

  async findInstance(funnelId: string, crmContactId: string): Promise<FunnelInstanceRecord | null> {
    const { rows } = await this.db.query<FunnelInstanceRow>('SELECT * FROM funnel_instances WHERE funnel_id = $1 AND crm_contact_id = $2', [funnelId, crmContactId]);
    return rows[0] ? toInstanceRecord(rows[0]) : null;
  }

  async findInstanceById(id: string): Promise<FunnelInstanceRecord | null> {
    const { rows } = await this.db.query<FunnelInstanceRow>('SELECT * FROM funnel_instances WHERE id = $1', [id]);
    return rows[0] ? toInstanceRecord(rows[0]) : null;
  }

  async listInstances(funnelId: string): Promise<FunnelInstanceRecord[]> {
    const { rows } = await this.db.query<FunnelInstanceRow>('SELECT * FROM funnel_instances WHERE funnel_id = $1 ORDER BY started_at DESC', [funnelId]);
    return rows.map(toInstanceRecord);
  }

  async updateInstance(
    id: string,
    input: { currentPosition?: number; status?: FunnelInstanceStatus; completedAt?: boolean; lastError?: string | null },
  ): Promise<FunnelInstanceRecord | null> {
    const { rows } = await this.db.query<FunnelInstanceRow>(
      `UPDATE funnel_instances SET
         current_position = COALESCE($2, current_position),
         status = COALESCE($3, status),
         completed_at = CASE WHEN $4 THEN now() ELSE completed_at END,
         last_error = COALESCE($5, last_error),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, input.currentPosition ?? null, input.status ?? null, input.completedAt ?? false, input.lastError ?? null],
    );
    return rows[0] ? toInstanceRecord(rows[0]) : null;
  }

  /** Real funnel analytics - entered/completed/active/failed counts, computed live, never a separately maintained counter. */
  async getInstanceCounts(funnelId: string): Promise<{ entered: number; active: number; completed: number; failed: number; cancelled: number }> {
    const { rows } = await this.db.query<{ entered: string; active: string; completed: string; failed: string; cancelled: string }>(
      `SELECT
         COUNT(*)::text AS entered,
         COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'WAITING'))::text AS active,
         COUNT(*) FILTER (WHERE status = 'COMPLETED')::text AS completed,
         COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::text AS cancelled
       FROM funnel_instances WHERE funnel_id = $1`,
      [funnelId],
    );
    const row = rows[0];
    return {
      entered: Number(row?.entered ?? '0'),
      active: Number(row?.active ?? '0'),
      completed: Number(row?.completed ?? '0'),
      failed: Number(row?.failed ?? '0'),
      cancelled: Number(row?.cancelled ?? '0'),
    };
  }
}
