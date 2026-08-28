import type { Queryable } from './types.js';

export interface CrmContactRecord {
  id: string;
  businessId: string;
  whatsappContactId: string | null;
  /** Only ever a real address someone entered - WhatsApp does not provide one, and nothing here derives it. */
  email: string | null;
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
  optedOutOfCampaigns: boolean;
  isHidden: boolean;
  syncExcluded: boolean;
  aiExcluded: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface CrmContactRow {
  id: string;
  business_id: string;
  whatsapp_contact_id: string | null;
  email: string | null;
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
  opted_out_of_campaigns: boolean;
  is_hidden: boolean;
  sync_excluded: boolean;
  ai_excluded: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: CrmContactRow): CrmContactRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappContactId: row.whatsapp_contact_id,
    email: row.email,
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
    optedOutOfCampaigns: row.opted_out_of_campaigns,
    isHidden: row.is_hidden,
    syncExcluded: row.sync_excluded,
    aiExcluded: row.ai_excluded,
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

export interface CrmContactWithContactInfo extends CrmContactRecord {
  whatsappJid: string | null;
  phoneNumber: string | null;
  contactDisplayName: string | null;
  contactPushName: string | null;
  contactVerifiedName: string | null;
  contactBusinessName: string | null;
  contactShortName: string | null;
}

interface CrmContactWithContactInfoRow extends CrmContactRow {
  whatsapp_jid: string | null;
  phone_number: string | null;
  contact_display_name: string | null;
  contact_push_name: string | null;
  contact_verified_name: string | null;
  contact_business_name: string | null;
  contact_short_name: string | null;
}

function toRecordWithContactInfo(row: CrmContactWithContactInfoRow): CrmContactWithContactInfo {
  return {
    ...toRecord(row),
    whatsappJid: row.whatsapp_jid,
    phoneNumber: row.phone_number,
    contactDisplayName: row.contact_display_name,
    contactPushName: row.contact_push_name,
    contactVerifiedName: row.contact_verified_name,
    contactBusinessName: row.contact_business_name,
    contactShortName: row.contact_short_name,
  };
}

export interface UpdateCrmContactInput {
  stage: string | null;
  leadStatus: string | null;
  notes: string | null;
  tags: string[];
  /** undefined leaves the stored address untouched; null clears it. */
  email?: string | null | undefined;
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

  /** Tenant-scoped lookup - confirms a crm_contact id genuinely belongs to this business before it's used to attach anything (e.g. a new lead). */
  async findByIdForBusiness(businessId: string, id: string): Promise<CrmContactRecord | null> {
    const { rows } = await this.db.query<CrmContactRow>(
      'SELECT * FROM crm_contacts WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL',
      [id, businessId],
    );
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

  /** The real CRM list view - joined with the WhatsApp contact it's built around so a caller can render a real name, never a bare id. */
  async listByBusiness(businessId: string, limit = 200): Promise<CrmContactWithContactInfo[]> {
    const { rows } = await this.db.query<CrmContactWithContactInfoRow>(
      `SELECT c.*,
              wc.whatsapp_jid, wc.phone_number,
              wc.display_name AS contact_display_name, wc.push_name AS contact_push_name,
              wc.verified_name AS contact_verified_name, wc.business_name AS contact_business_name,
              wc.short_name AS contact_short_name
       FROM crm_contacts c
       LEFT JOIN whatsapp_contacts wc ON wc.id = c.whatsapp_contact_id
       WHERE c.business_id = $1 AND c.deleted_at IS NULL AND c.is_hidden = false
       ORDER BY c.updated_at DESC
       LIMIT $2`,
      [businessId, limit],
    );
    return rows.map(toRecordWithContactInfo);
  }

  /** Tenant-scoped write - a crm_contact id from another business is never editable through this. */
  async update(businessId: string, id: string, input: UpdateCrmContactInput): Promise<CrmContactRecord | null> {
    const { rows } = await this.db.query<CrmContactRow>(
      `UPDATE crm_contacts SET
         stage = $3, lead_status = $4, notes = $5, tags = $6::jsonb,
         email = CASE WHEN $8 THEN $7 ELSE email END,
         updated_at = now()
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [
        id,
        businessId,
        input.stage,
        input.leadStatus,
        input.notes,
        JSON.stringify(input.tags),
        input.email ?? null,
        input.email !== undefined,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setPrivacyFlags(
    businessId: string,
    id: string,
    flags: { isHidden?: boolean | undefined; syncExcluded?: boolean | undefined; aiExcluded?: boolean | undefined },
  ): Promise<CrmContactRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [id, businessId];
    if (flags.isHidden !== undefined) { values.push(flags.isHidden); sets.push(`is_hidden = $${values.length}`); }
    if (flags.syncExcluded !== undefined) { values.push(flags.syncExcluded); sets.push(`sync_excluded = $${values.length}`); }
    if (flags.aiExcluded !== undefined) { values.push(flags.aiExcluded); sets.push(`ai_excluded = $${values.length}`); }
    if (sets.length === 0) return this.findByIdForBusiness(businessId, id);
    sets.push('updated_at = now()');
    const { rows } = await this.db.query<CrmContactRow>(
      `UPDATE crm_contacts SET ${sets.join(', ')} WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL RETURNING *`,
      values,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The real, enforced do-not-contact flag for campaigns - independent of stage/lead status. */
  async setOptedOut(businessId: string, id: string, optedOut: boolean): Promise<CrmContactRecord | null> {
    const { rows } = await this.db.query<CrmContactRow>(
      `UPDATE crm_contacts SET opted_out_of_campaigns = $3, updated_at = now()
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [id, businessId, optedOut],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
