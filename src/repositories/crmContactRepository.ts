import type { Queryable } from './types.js';

export interface CrmContactRecord {
  id: string;
  businessId: string;
  whatsappContactId: string | null;
  source: string | null;
  stage: string | null;
  leadStatus: string | null;
  tags: string[];
  notes: string | null;
  ownerUserId: string | null;
  aiSummary: string | null;
  customerValue: number | null;
  followUpDate: string | null;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface CrmContactRow {
  id: string;
  business_id: string;
  whatsapp_contact_id: string | null;
  source: string | null;
  stage: string | null;
  lead_status: string | null;
  tags: string[];
  notes: string | null;
  owner_user_id: string | null;
  ai_summary: string | null;
  customer_value: string | null;
  follow_up_date: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: CrmContactRow): CrmContactRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappContactId: row.whatsapp_contact_id,
    source: row.source,
    stage: row.stage,
    leadStatus: row.lead_status,
    tags: row.tags,
    notes: row.notes,
    ownerUserId: row.owner_user_id,
    aiSummary: row.ai_summary,
    customerValue: row.customer_value === null ? null : Number(row.customer_value),
    followUpDate: row.follow_up_date,
    customFields: row.custom_fields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface UpsertCrmContactInput {
  businessId: string;
  whatsappContactId: string;
  source?: string | null;
  stage?: string | null;
  leadStatus?: string | null;
}

export class CrmContactRepository {
  constructor(private readonly db: Queryable) {}

  /** One CRM profile per real WhatsApp contact identity - never a duplicate. */
  async upsertForWhatsAppContact(input: UpsertCrmContactInput): Promise<CrmContactRecord> {
    const { rows } = await this.db.query<CrmContactRow>(
      `INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source, stage, lead_status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, whatsapp_contact_id) WHERE whatsapp_contact_id IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET
         source = COALESCE(EXCLUDED.source, crm_contacts.source),
         stage = COALESCE(EXCLUDED.stage, crm_contacts.stage),
         lead_status = COALESCE(EXCLUDED.lead_status, crm_contacts.lead_status),
         updated_at = now()
       RETURNING *`,
      [input.businessId, input.whatsappContactId, input.source ?? null, input.stage ?? null, input.leadStatus ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('crm_contacts upsert returned no row');
    return toRecord(row);
  }

  async findById(id: string): Promise<CrmContactRecord | null> {
    const { rows } = await this.db.query<CrmContactRow>('SELECT * FROM crm_contacts WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByWhatsAppContact(businessId: string, whatsappContactId: string): Promise<CrmContactRecord | null> {
    const { rows } = await this.db.query<CrmContactRow>(
      `SELECT * FROM crm_contacts
       WHERE business_id = $1 AND whatsapp_contact_id = $2 AND deleted_at IS NULL`,
      [businessId, whatsappContactId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
