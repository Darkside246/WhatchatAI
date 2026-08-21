import type { Queryable } from './types.js';

export const EMAIL_KINDS = ['custom', 'order_update', 'appointment', 'receipt', 'invoice', 'general_update'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export type EmailStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'indeterminate';

export interface EmailMessageRecord {
  id: string;
  businessId: string;
  createdBy: string | null;
  draftedByAgentId: string | null;
  chatId: string | null;
  crmContactId: string | null;
  kind: EmailKind;
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyText: string;
  status: EmailStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  provider: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EmailMessageRow {
  id: string;
  business_id: string;
  created_by: string | null;
  drafted_by_agent_id: string | null;
  chat_id: string | null;
  crm_contact_id: string | null;
  kind: EmailKind;
  to_email: string;
  to_name: string | null;
  subject: string;
  body_text: string;
  status: EmailStatus;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  provider: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: EmailMessageRow): EmailMessageRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    createdBy: row.created_by,
    draftedByAgentId: row.drafted_by_agent_id,
    chatId: row.chat_id,
    crmContactId: row.crm_contact_id,
    kind: row.kind,
    toEmail: row.to_email,
    toName: row.to_name,
    subject: row.subject,
    bodyText: row.body_text,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateEmailDraftInput {
  businessId: string;
  createdBy?: string | null;
  draftedByAgentId?: string | null;
  chatId?: string | null;
  crmContactId?: string | null;
  kind: EmailKind;
  toEmail: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
}

export interface BusinessEmailSettingsRecord {
  businessId: string;
  fromEmail: string;
  fromName: string | null;
  replyToEmail: string | null;
}

export class EmailMessageRepository {
  constructor(private readonly db: Queryable) {}

  async createDraft(input: CreateEmailDraftInput): Promise<EmailMessageRecord> {
    const { rows } = await this.db.query<EmailMessageRow>(
      `INSERT INTO email_messages
         (business_id, created_by, drafted_by_agent_id, chat_id, crm_contact_id, kind, to_email, to_name, subject, body_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.businessId,
        input.createdBy ?? null,
        input.draftedByAgentId ?? null,
        input.chatId ?? null,
        input.crmContactId ?? null,
        input.kind,
        input.toEmail,
        input.toName ?? null,
        input.subject,
        input.bodyText,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('email_messages insert returned no row');
    return toRecord(row);
  }

  async findByIdForBusiness(businessId: string, id: string): Promise<EmailMessageRecord | null> {
    const { rows } = await this.db.query<EmailMessageRow>(
      'SELECT * FROM email_messages WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<EmailMessageRecord | null> {
    const { rows } = await this.db.query<EmailMessageRow>('SELECT * FROM email_messages WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string, status?: EmailStatus): Promise<EmailMessageRecord[]> {
    const { rows } = await this.db.query<EmailMessageRow>(
      `SELECT * FROM email_messages
       WHERE business_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC
       LIMIT 200`,
      [businessId, status ?? null],
    );
    return rows.map(toRecord);
  }

  /** Editing is only ever allowed while still a draft - an approved email must not change under the approver's feet. */
  async updateDraft(
    businessId: string,
    id: string,
    input: { subject: string; bodyText: string; toEmail: string; toName: string | null },
  ): Promise<EmailMessageRecord | null> {
    const { rows } = await this.db.query<EmailMessageRow>(
      `UPDATE email_messages
         SET subject = $3, body_text = $4, to_email = $5, to_name = $6, updated_at = now()
       WHERE id = $1 AND business_id = $2 AND status = 'draft'
       RETURNING *`,
      [id, businessId, input.subject, input.bodyText, input.toEmail, input.toName],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Claims a draft for sending by recording a real human approver. Returns
   * null when the row is not an approvable draft, so a double-approve or a
   * race cannot produce two sends.
   */
  async approve(businessId: string, id: string, approvedBy: string): Promise<EmailMessageRecord | null> {
    const { rows } = await this.db.query<EmailMessageRow>(
      `UPDATE email_messages
         SET status = 'approved', approved_by = $3, approved_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1 AND business_id = $2 AND status = 'draft'
       RETURNING *`,
      [id, businessId, approvedBy],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** approved -> sending, only once. Guards against a duplicate job double-sending. */
  async markSending(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE email_messages SET status = 'sending', updated_at = now() WHERE id = $1 AND status = 'approved'`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Puts a claimed row back so a later retry can claim it again. Without
   * this a transient provider error would strand the email in 'sending'
   * forever: markSending only ever matches 'approved'. The approver is
   * preserved, so the send still requires the original real approval.
   */
  async revertToApproved(id: string): Promise<void> {
    await this.db.query(
      `UPDATE email_messages SET status = 'approved', updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [id],
    );
  }

  async markSent(id: string, provider: string, providerMessageId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE email_messages
         SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [id, provider, providerMessageId],
    );
  }

  /**
   * Returns to 'failed' rather than 'draft': the approval genuinely happened
   * and the audit trail must keep it. Retrying is an explicit new approval.
   */
  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE email_messages SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [id, reason.slice(0, 500)],
    );
  }

  /**
   * A send left stuck in 'sending' with no worker left to resolve it (the
   * process crashed between sendEmail() resolving and markSent()/markFailed()
   * committing). markSending() only ever re-claims a row that is 'approved',
   * so nothing else can ever pick this back up - unlike the identical
   * WhatsApp case, there is no BullMQ retry waiting in the wings. Whether the
   * provider actually sent it is genuinely unknown, so this is reconciled to
   * 'indeterminate', never a false 'failed' or a silent forever-'sending'.
   */
  async findStalePending(staleAfterSeconds: number): Promise<EmailMessageRecord[]> {
    const { rows } = await this.db.query<EmailMessageRow>(
      `SELECT * FROM email_messages
       WHERE status = 'sending' AND updated_at < now() - ($1 || ' seconds')::interval`,
      [staleAfterSeconds],
    );
    return rows.map(toRecord);
  }

  async markIndeterminate(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE email_messages SET status = 'indeterminate', last_error = $2, updated_at = now() WHERE id = $1`,
      [id, reason.slice(0, 500)],
    );
  }

  async cancel(businessId: string, id: string): Promise<EmailMessageRecord | null> {
    const { rows } = await this.db.query<EmailMessageRow>(
      `UPDATE email_messages
         SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND business_id = $2 AND status IN ('draft', 'approved', 'failed')
       RETURNING *`,
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async getSettings(businessId: string): Promise<BusinessEmailSettingsRecord | null> {
    const { rows } = await this.db.query<{ business_id: string; from_email: string; from_name: string | null; reply_to_email: string | null }>(
      'SELECT business_id, from_email, from_name, reply_to_email FROM business_email_settings WHERE business_id = $1',
      [businessId],
    );
    const row = rows[0];
    if (!row) return null;
    return { businessId: row.business_id, fromEmail: row.from_email, fromName: row.from_name, replyToEmail: row.reply_to_email };
  }

  async upsertSettings(input: BusinessEmailSettingsRecord): Promise<BusinessEmailSettingsRecord> {
    await this.db.query(
      `INSERT INTO business_email_settings (business_id, from_email, from_name, reply_to_email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id) DO UPDATE
         SET from_email = EXCLUDED.from_email,
             from_name = EXCLUDED.from_name,
             reply_to_email = EXCLUDED.reply_to_email,
             updated_at = now()`,
      [input.businessId, input.fromEmail, input.fromName, input.replyToEmail],
    );
    return input;
  }
}
