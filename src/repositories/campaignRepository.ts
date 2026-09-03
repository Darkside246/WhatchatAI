import type { Queryable } from './types.js';

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'SCHEDULED',
  'RUNNING',
  'COMPLETED',
  'PAUSED',
  'CANCELLED',
  'FAILED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface CampaignRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  name: string;
  messageText: string;
  status: CampaignStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CampaignRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  created_by: string;
  name: string;
  message_text: string;
  status: CampaignStatus;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toCampaignRecord(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    createdBy: row.created_by,
    name: row.name,
    messageText: row.message_text,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** "Real, honest" recipient statuses - always derived from the actual send pipeline, never a fabricated intermediate state. */
export type RecipientStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed';

export interface CampaignRecipientRecord {
  id: string;
  campaignId: string;
  crmContactId: string;
  chatId: string;
  outboundMessageId: string | null;
  displayName: string;
  phoneNumber: string | null;
  status: RecipientStatus | null;
  lastError: string | null;
  createdAt: string;
}

interface CampaignRecipientRow {
  id: string;
  campaign_id: string;
  crm_contact_id: string;
  chat_id: string;
  outbound_message_id: string | null;
  display_name: string | null;
  phone_number: string | null;
  status: RecipientStatus | null;
  last_error: string | null;
  created_at: string;
}

function toRecipientRecord(row: CampaignRecipientRow): CampaignRecipientRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    crmContactId: row.crm_contact_id,
    chatId: row.chat_id,
    outboundMessageId: row.outbound_message_id,
    displayName: row.display_name ?? 'Unknown',
    phoneNumber: row.phone_number,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export interface EligibleRecipient {
  crmContactId: string;
  chatId: string;
  displayName: string;
  phoneNumber: string | null;
}

interface EligibleRecipientRow {
  crm_contact_id: string;
  chat_id: string;
  display_name: string | null;
  phone_number: string | null;
}

export interface CreateCampaignInput {
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  name: string;
  messageText: string;
}

/**
 * Every recipient status here is computed live by joining through to the
 * real send pipeline - whatsapp_outbound_messages first (queued/sending/
 * sent/failed), then the real whatsapp_messages row once linked, for the
 * fuller delivered/read lifecycle. There is no duplicated status column to
 * go stale.
 *
 * Section 26 (Message Delivery Status Reconciliation) - real bug found and
 * fixed here: whatsapp_messages.status is `NOT NULL DEFAULT 'unknown'`
 * (007_create_whatsapp_messages.sql), never actually NULL for a real row -
 * this CASE originally checked `wm.status IS NOT NULL`, which is true the
 * instant a message row is linked, before any real delivery/read ack has
 * ever arrived. That made every freshly-sent (linked, not yet acked)
 * recipient show the literal placeholder 'unknown' instead of 'sent' -
 * exactly the "stuck at nothing" symptom this section describes. Fixed by
 * treating wm.status = 'unknown' the same as "no real ack yet" and falling
 * through to the outbound message's own real 'sent' status instead.
 */
const RECIPIENT_STATUS_SELECT = `
  cr.id, cr.campaign_id, cr.crm_contact_id, cr.chat_id, cr.outbound_message_id,
  COALESCE(wc.display_name, wc.push_name, wc.verified_name, wc.business_name) AS display_name,
  wc.phone_number,
  CASE
    WHEN om.status = 'failed' THEN 'failed'
    WHEN wm.status IS NOT NULL AND wm.status != 'unknown' THEN wm.status::text
    WHEN om.status IS NOT NULL THEN om.status::text
    WHEN cr.last_error IS NOT NULL THEN 'failed'
    ELSE NULL
  END AS status,
  cr.last_error,
  cr.created_at
`;

export class CampaignRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateCampaignInput): Promise<CampaignRecord> {
    const { rows } = await this.db.query<CampaignRow>(
      `INSERT INTO campaigns (business_id, whatsapp_account_id, created_by, name, message_text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.businessId, input.whatsappAccountId, input.createdBy, input.name, input.messageText],
    );
    const row = rows[0];
    if (!row) throw new Error('campaigns insert returned no row');
    return toCampaignRecord(row);
  }

  async findByIdForBusiness(businessId: string, id: string): Promise<CampaignRecord | null> {
    const { rows } = await this.db.query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1 AND business_id = $2', [id, businessId]);
    return rows[0] ? toCampaignRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<CampaignRecord[]> {
    const { rows } = await this.db.query<CampaignRow>('SELECT * FROM campaigns WHERE business_id = $1 ORDER BY created_at DESC', [businessId]);
    return rows.map(toCampaignRecord);
  }

  /** In-flight campaigns (not yet cancelled/completed/failed) - the real usage a "max active campaigns" entitlement caps. */
  async countInFlightByBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM campaigns
       WHERE business_id = $1 AND status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED')`,
      [businessId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async updateDraft(id: string, name: string, messageText: string): Promise<CampaignRecord | null> {
    const { rows } = await this.db.query<CampaignRow>(
      `UPDATE campaigns SET name = $2, message_text = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, name, messageText],
    );
    return rows[0] ? toCampaignRecord(rows[0]) : null;
  }

  async updateStatus(
    id: string,
    status: CampaignStatus,
    extra: { approvedBy?: string; approvedAt?: boolean; sentAt?: boolean; completedAt?: boolean } = {},
  ): Promise<CampaignRecord | null> {
    const { rows } = await this.db.query<CampaignRow>(
      `UPDATE campaigns SET
         status = $2,
         approved_by = COALESCE($3, approved_by),
         approved_at = CASE WHEN $4 THEN now() ELSE approved_at END,
         sent_at = CASE WHEN $5 THEN now() ELSE sent_at END,
         completed_at = CASE WHEN $6 THEN now() ELSE completed_at END,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, status, extra.approvedBy ?? null, extra.approvedAt ?? false, extra.sentAt ?? false, extra.completedAt ?? false],
    );
    return rows[0] ? toCampaignRecord(rows[0]) : null;
  }

  /**
   * Real eligibility, computed from real data: a business's CRM contacts
   * that have a linked WhatsApp identity, an existing conversation (a real
   * chat row - never a fabricated "reachable" contact), and have not opted
   * out. This is the only source campaign recipients may ever be drawn
   * from - see the migration's own note on why cold outreach is refused at
   * this level.
   */
  async listEligibleRecipients(businessId: string, whatsappAccountId: string): Promise<EligibleRecipient[]> {
    const { rows } = await this.db.query<EligibleRecipientRow>(
      `SELECT c.id AS crm_contact_id, ch.id AS chat_id,
              COALESCE(wc.display_name, wc.push_name, wc.verified_name, wc.business_name) AS display_name,
              wc.phone_number
       FROM crm_contacts c
       JOIN whatsapp_contacts wc ON wc.id = c.whatsapp_contact_id
       JOIN whatsapp_chats ch ON ch.contact_id = wc.id AND ch.whatsapp_account_id = $2 AND ch.deleted_at IS NULL
       WHERE c.business_id = $1 AND c.deleted_at IS NULL AND c.opted_out_of_campaigns = false
       ORDER BY display_name NULLS LAST`,
      [businessId, whatsappAccountId],
    );
    return rows.map((row) => ({
      crmContactId: row.crm_contact_id,
      chatId: row.chat_id,
      displayName: row.display_name ?? 'Unknown',
      phoneNumber: row.phone_number,
    }));
  }

  async createRecipients(campaignId: string, recipients: { crmContactId: string; chatId: string }[]): Promise<number> {
    if (recipients.length === 0) return 0;
    const values: string[] = [];
    const params: unknown[] = [campaignId];
    recipients.forEach((recipient, index) => {
      const base = index * 2;
      values.push(`($1, $${base + 2}, $${base + 3})`);
      params.push(recipient.crmContactId, recipient.chatId);
    });
    const { rowCount } = await this.db.query(
      `INSERT INTO campaign_recipients (campaign_id, crm_contact_id, chat_id) VALUES ${values.join(', ')}
       ON CONFLICT (campaign_id, crm_contact_id) DO NOTHING`,
      params,
    );
    return rowCount ?? 0;
  }

  async listRecipients(campaignId: string): Promise<CampaignRecipientRecord[]> {
    const { rows } = await this.db.query<CampaignRecipientRow>(
      `SELECT ${RECIPIENT_STATUS_SELECT}
       FROM campaign_recipients cr
       JOIN crm_contacts c ON c.id = cr.crm_contact_id
       LEFT JOIN whatsapp_contacts wc ON wc.id = c.whatsapp_contact_id
       LEFT JOIN whatsapp_outbound_messages om ON om.id = cr.outbound_message_id
       LEFT JOIN whatsapp_messages wm ON wm.id = om.message_id
       WHERE cr.campaign_id = $1
       ORDER BY cr.created_at`,
      [campaignId],
    );
    return rows.map(toRecipientRecord);
  }

  /** The list of recipients still needing an actual send - used by the dispatch loop, never a stale cached list. */
  async listUndispatchedRecipients(campaignId: string): Promise<{ id: string; chatId: string }[]> {
    const { rows } = await this.db.query<{ id: string; chat_id: string }>(
      `SELECT id, chat_id FROM campaign_recipients WHERE campaign_id = $1 AND outbound_message_id IS NULL ORDER BY created_at`,
      [campaignId],
    );
    return rows.map((row) => ({ id: row.id, chatId: row.chat_id }));
  }

  async linkOutboundMessage(recipientId: string, outboundMessageId: string): Promise<void> {
    await this.db.query('UPDATE campaign_recipients SET outbound_message_id = $2 WHERE id = $1', [recipientId, outboundMessageId]);
  }

  /**
   * Records a real dispatch-time failure (e.g. whatsappOutboundMessageService.send
   * threw before any outbound_message row could even be created - a vanished
   * chat, a media error) so this recipient reaches an honest terminal state
   * instead of sitting in outbound_message_id IS NULL forever, which
   * getStatusCounts previously read as permanently 'queued' - the exact
   * silent-stuck-forever gap this codebase already closed for sync jobs,
   * outbound messages, and emails via their own last_error columns.
   */
  async recordDispatchFailure(recipientId: string, error: string): Promise<void> {
    await this.db.query('UPDATE campaign_recipients SET last_error = $2 WHERE id = $1', [recipientId, error]);
  }

  /**
   * The real whatsapp_messages rows a campaign actually put on WhatsApp and
   * that are still revocable. Recipients that never got sent, or whose
   * revoke already ran, are excluded - a recall must not claim to have
   * touched a message that was never delivered in the first place.
   */
  async listRevocableMessageIds(campaignId: string): Promise<{ messageId: string; whatsappAccountId: string }[]> {
    const { rows } = await this.db.query<{ id: string; whatsapp_account_id: string }>(
      `SELECT wm.id, wm.whatsapp_account_id
       FROM campaign_recipients cr
       JOIN whatsapp_outbound_messages om ON om.id = cr.outbound_message_id
       JOIN whatsapp_messages wm ON wm.id = om.message_id
       WHERE cr.campaign_id = $1
         AND wm.from_me = true
         AND wm.revoke_status IN ('none', 'failed')
       ORDER BY cr.created_at`,
      [campaignId],
    );
    return rows.map((row) => ({ messageId: row.id, whatsappAccountId: row.whatsapp_account_id }));
  }

  /**
   * Every recipient's own outbound message id, whatever its current state -
   * the caller (cancelCampaign's emergency-stop path) is responsible for
   * only acting on the ones still genuinely stoppable (the repository's own
   * cancelQueuedByIds only ever matches 'queued', never a message already
   * sending/sent).
   */
  async listOutboundMessageIds(campaignId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ outbound_message_id: string }>(
      `SELECT outbound_message_id FROM campaign_recipients WHERE campaign_id = $1 AND outbound_message_id IS NOT NULL`,
      [campaignId],
    );
    return rows.map((row) => row.outbound_message_id);
  }

  async hardDelete(businessId: string, campaignId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM campaigns WHERE id = $1 AND business_id = $2`,
      [campaignId, businessId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Real, live counts by status - computed the same way listRecipients derives status, never a separately maintained counter. */
  async getStatusCounts(
    campaignId: string,
  ): Promise<{ total: number; queued: number; sent: number; delivered: number; read: number; failed: number; cancelled: number }> {
    const { rows } = await this.db.query<{
      total: string;
      queued: string;
      sent: string;
      delivered: string;
      read: string;
      failed: string;
      cancelled: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE (om.id IS NULL AND cr.last_error IS NULL) OR om.status IN ('queued', 'sending'))::text AS queued,
         COUNT(*) FILTER (WHERE om.status = 'sent' AND (wm.id IS NULL OR wm.status = 'unknown'))::text AS sent,
         COUNT(*) FILTER (WHERE wm.status IN ('delivered', 'played'))::text AS delivered,
         COUNT(*) FILTER (WHERE wm.status = 'read')::text AS read,
         COUNT(*) FILTER (WHERE om.status = 'failed' OR (om.id IS NULL AND cr.last_error IS NOT NULL))::text AS failed,
         COUNT(*) FILTER (WHERE om.status = 'cancelled')::text AS cancelled
       FROM campaign_recipients cr
       LEFT JOIN whatsapp_outbound_messages om ON om.id = cr.outbound_message_id
       LEFT JOIN whatsapp_messages wm ON wm.id = om.message_id
       WHERE cr.campaign_id = $1`,
      [campaignId],
    );
    const row = rows[0];
    return {
      total: Number(row?.total ?? '0'),
      queued: Number(row?.queued ?? '0'),
      sent: Number(row?.sent ?? '0'),
      cancelled: Number(row?.cancelled ?? '0'),
      delivered: Number(row?.delivered ?? '0'),
      read: Number(row?.read ?? '0'),
      failed: Number(row?.failed ?? '0'),
    };
  }
}
