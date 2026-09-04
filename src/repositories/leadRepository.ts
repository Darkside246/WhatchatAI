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
  source?: string | null | undefined;
  stage?: string | null | undefined;
  score?: number | null | undefined;
  value?: number | null | undefined;
  nextAction?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface LeadWithContactInfo extends LeadRecord {
  whatsappJid: string | null;
  phoneNumber: string | null;
  contactDisplayName: string | null;
  contactPushName: string | null;
  contactVerifiedName: string | null;
  contactBusinessName: string | null;
  contactShortName: string | null;
  /** Section 23: a staff member's manual correction/confirmation on the underlying CRM contact - outranks every other source when displaying this lead. */
  contactManualDisplayName: string | null;
}

interface LeadWithContactInfoRow extends LeadRow {
  whatsapp_jid: string | null;
  phone_number: string | null;
  contact_display_name: string | null;
  contact_push_name: string | null;
  contact_verified_name: string | null;
  contact_business_name: string | null;
  contact_short_name: string | null;
  contact_manual_display_name: string | null;
}

function toRecordWithContactInfo(row: LeadWithContactInfoRow): LeadWithContactInfo {
  return {
    ...toRecord(row),
    whatsappJid: row.whatsapp_jid,
    phoneNumber: row.phone_number,
    contactDisplayName: row.contact_display_name,
    contactPushName: row.contact_push_name,
    contactVerifiedName: row.contact_verified_name,
    contactBusinessName: row.contact_business_name,
    contactShortName: row.contact_short_name,
    contactManualDisplayName: row.contact_manual_display_name,
  };
}

export interface UpdateLeadInput {
  stage: string | null;
  score: number | null;
  value: number | null;
  nextAction: string | null;
  notes: string | null;
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

  /**
   * Tenant-scoped read - a lead id from another business returns null,
   * indistinguishable from a genuinely nonexistent one. Defense-in-depth
   * for callers (e.g. openclawToolGateway.execute()) that re-fetch a lead
   * after an earlier authorization step has already run - the boundary is
   * re-enforced at the data-access layer instead of relying solely on that
   * earlier check.
   */
  async findByIdForBusiness(id: string, businessId: string): Promise<LeadRecord | null> {
    const { rows } = await this.db.query<LeadRow>('SELECT * FROM leads WHERE id = $1 AND business_id = $2', [
      id,
      businessId,
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByCrmContact(crmContactId: string): Promise<LeadRecord[]> {
    const { rows } = await this.db.query<LeadRow>(
      'SELECT * FROM leads WHERE crm_contact_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [crmContactId],
    );
    return rows.map(toRecord);
  }

  /**
   * The real pipeline view - joined through crm_contacts to the WhatsApp
   * contact it's built around so a caller can render a real name, never a
   * bare id. Also half of Section 67's bulk CRM export (alongside
   * crmContactRepository.listByBusiness, see its doc comment) -
   * `excludeSyncExcluded` exists for that caller: a lead tied to a contact
   * staff marked "Exclude from sync" carries that same contact's PII
   * through this join, so it needs the identical filter or the export
   * leaks the excluded contact's data through the leads half instead. The
   * everyday Pipeline view leaves this off.
   *
   * `c.is_hidden = false` is unconditional, unlike sync_excluded above -
   * a contact staff hid via "Hide from CRM list" (crmContactRepository's
   * own listByBusiness already enforces this on the contacts side) must
   * never surface through a lead tied to them either, in the Pipeline
   * view or the export - this was a real gap: the join here pulled the
   * same contact PII with no such filter at all before this fix.
   */
  async listByBusiness(businessId: string, limit = 200, options?: { excludeSyncExcluded?: boolean }): Promise<LeadWithContactInfo[]> {
    const { rows } = await this.db.query<LeadWithContactInfoRow>(
      `SELECT l.*,
              wc.whatsapp_jid, wc.phone_number,
              wc.display_name AS contact_display_name, wc.push_name AS contact_push_name,
              wc.verified_name AS contact_verified_name, wc.business_name AS contact_business_name,
              wc.short_name AS contact_short_name, c.manual_display_name AS contact_manual_display_name
       FROM leads l
       JOIN crm_contacts c ON c.id = l.crm_contact_id
       LEFT JOIN whatsapp_contacts wc ON wc.id = c.whatsapp_contact_id
       WHERE l.business_id = $1 AND l.deleted_at IS NULL AND c.is_hidden = false
         AND ($3::boolean IS NOT TRUE OR c.sync_excluded = false)
       ORDER BY l.updated_at DESC
       LIMIT $2`,
      [businessId, limit, options?.excludeSyncExcluded ?? false],
    );
    return rows.map(toRecordWithContactInfo);
  }

  /**
   * Section 48 (Autonomous Morning Briefing): real leads actually created
   * since a point in time - never a fabricated "new leads overnight"
   * count. Same real contact join as listByBusiness, including the same
   * `is_hidden = false` filter (Section 75-91 follow-up) - a contact
   * staff hid via "Hide from CRM list" must never surface in the morning
   * briefing's "new leads overnight" summary either.
   */
  async listCreatedSince(businessId: string, sinceIso: string, limit = 50): Promise<LeadWithContactInfo[]> {
    const { rows } = await this.db.query<LeadWithContactInfoRow>(
      `SELECT l.*,
              wc.whatsapp_jid, wc.phone_number,
              wc.display_name AS contact_display_name, wc.push_name AS contact_push_name,
              wc.verified_name AS contact_verified_name, wc.business_name AS contact_business_name,
              wc.short_name AS contact_short_name, c.manual_display_name AS contact_manual_display_name
       FROM leads l
       JOIN crm_contacts c ON c.id = l.crm_contact_id
       LEFT JOIN whatsapp_contacts wc ON wc.id = c.whatsapp_contact_id
       WHERE l.business_id = $1 AND l.deleted_at IS NULL AND l.created_at >= $2 AND c.is_hidden = false
       ORDER BY l.created_at DESC
       LIMIT $3`,
      [businessId, sinceIso, limit],
    );
    return rows.map(toRecordWithContactInfo);
  }

  /** Tenant-scoped write - a lead id from another business is never editable through this. */
  async update(businessId: string, id: string, input: UpdateLeadInput): Promise<LeadRecord | null> {
    const { rows } = await this.db.query<LeadRow>(
      `UPDATE leads SET stage = $3, score = $4, value = $5, next_action = $6, notes = $7, last_activity_at = now(), updated_at = now()
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [id, businessId, input.stage, input.score, input.value, input.nextAction, input.notes],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Section 11 (lead qualification): the one write leadScoringService.ts is
   * allowed to make to `score` - only when it has never been set by
   * anyone. There is no provenance flag distinguishing "staff typed this"
   * from "the system computed this," so an unconditional overwrite on
   * every recompute could silently clobber a real manual number - this
   * DB-level guard (not a read-then-write check, which would race) makes
   * that structurally impossible: it only ever fills a genuinely blank
   * score, once.
   */
  async setScoreIfUnset(businessId: string, id: string, score: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE leads SET score = $3, updated_at = now() WHERE id = $1 AND business_id = $2 AND score IS NULL AND deleted_at IS NULL`,
      [id, businessId, score],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Section 11: the one status transition leadScoringService.ts is allowed
   * to make - NEW -> QUALIFIED only, and only from NEW specifically (never
   * ENGAGED/WON/LOST, which are exclusively human decisions this system
   * must never second-guess or reverse). Same DB-level guard as
   * setScoreIfUnset - the WHERE clause is the only thing that decides
   * whether this fires, not a prior read.
   */
  async autoQualifyIfNew(businessId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE leads SET status = 'QUALIFIED', last_activity_at = now(), updated_at = now() WHERE id = $1 AND business_id = $2 AND status = 'NEW' AND deleted_at IS NULL`,
      [id, businessId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Tenant-scoped status transition - a lead id from another business is never editable through this. */
  async updateStatusForBusiness(businessId: string, id: string, status: LeadStatus): Promise<LeadRecord | null> {
    const { rows } = await this.db.query<LeadRow>(
      `UPDATE leads SET status = $3, last_activity_at = now(), updated_at = now()
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [id, businessId, status],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
