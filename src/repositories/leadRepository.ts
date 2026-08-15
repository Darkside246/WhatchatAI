import type { Queryable } from './types.js';
import type { LeadStatus } from '../domain/platform/types.js';

export interface LeadRecord {
  id: string;
  businessId: string;
  crmContactId: string;
  source: string | null;
  stage: string | null;
  status: LeadStatus;
  score: number | null;
  value: number | null;
  lastActivityAt: string | null;
  nextAction: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LeadRow {
  id: string;
  business_id: string;
  crm_contact_id: string;
  source: string | null;
  stage: string | null;
  status: LeadStatus;
  score: string | null;
  value: string | null;
  last_activity_at: string | null;
  next_action: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    crmContactId: row.crm_contact_id,
    source: row.source,
    stage: row.stage,
    status: row.status,
    score: row.score === null ? null : Number(row.score),
    value: row.value === null ? null : Number(row.value),
    lastActivityAt: row.last_activity_at,
    nextAction: row.next_action,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateLeadInput {
  businessId: string;
  crmContactId: string;
  source?: string | null;
  stage?: string | null;
  score?: number | null;
  value?: number | null;
  nextAction?: string | null;
  notes?: string | null;
}

export class LeadRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateLeadInput): Promise<LeadRecord> {
    const { rows } = await this.db.query<LeadRow>(
      `INSERT INTO leads (business_id, crm_contact_id, source, stage, score, value, next_action, notes, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING *`,
      [
        input.businessId,
        input.crmContactId,
        input.source ?? null,
        input.stage ?? null,
        input.score ?? null,
        input.value ?? null,
        input.nextAction ?? null,
        input.notes ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('leads insert returned no row');
    return toRecord(row);
  }

  async updateStatus(id: string, status: LeadStatus): Promise<void> {
    await this.db.query('UPDATE leads SET status = $2, last_activity_at = now(), updated_at = now() WHERE id = $1', [
      id,
      status,
    ]);
  }

  async findById(id: string): Promise<LeadRecord | null> {
    const { rows } = await this.db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByCrmContact(crmContactId: string): Promise<LeadRecord[]> {
    const { rows } = await this.db.query<LeadRow>(
      'SELECT * FROM leads WHERE crm_contact_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [crmContactId],
    );
    return rows.map(toRecord);
  }
}
