import type { Queryable } from './types.js';

export type ReminderStatus = 'PENDING' | 'SENT' | 'CANCELLED' | 'FAILED';

export interface ReminderRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  notifyJid: string;
  message: string;
  dueAt: string;
  status: ReminderStatus;
  createdByJid: string;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReminderRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  notify_jid: string;
  message: string;
  due_at: string;
  status: ReminderStatus;
  created_by_jid: string;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    notifyJid: row.notify_jid,
    message: row.message,
    dueAt: row.due_at,
    status: row.status,
    createdByJid: row.created_by_jid,
    sentAt: row.sent_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReminderRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    businessId: string;
    whatsappAccountId: string;
    notifyJid: string;
    message: string;
    dueAt: string;
    createdByJid: string;
  }): Promise<ReminderRecord> {
    const { rows } = await this.db.query<ReminderRow>(
      `INSERT INTO reminders (business_id, whatsapp_account_id, notify_jid, message, due_at, created_by_jid)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.businessId, input.whatsappAccountId, input.notifyJid, input.message, input.dueAt, input.createdByJid],
    );
    const row = rows[0];
    if (!row) throw new Error('reminder insert returned no row');
    return toRecord(row);
  }

  async findByIdForBusiness(id: string, businessId: string): Promise<ReminderRecord | null> {
    const { rows } = await this.db.query<ReminderRow>(
      `SELECT * FROM reminders WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Upcoming, still-pending reminders for a business - the "what do I have coming up" listing. */
  async listUpcoming(businessId: string, limit = 20): Promise<ReminderRecord[]> {
    const { rows } = await this.db.query<ReminderRow>(
      `SELECT * FROM reminders WHERE business_id = $1 AND status = 'PENDING' ORDER BY due_at ASC LIMIT $2`,
      [businessId, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Guarded claim, not a plain SELECT: only a PENDING row whose due_at has
   * passed is eligible, and the caller must immediately follow up with
   * markSent/markFailed - see the sweep in incomingMessagesWorker.ts. Real
   * concurrency safety matters here in the same way it does for
   * claimAiHandoff: two overlapping sweep ticks (a slow send plus the next
   * scheduled tick) must never both send the same reminder twice.
   */
  async claimDue(now: string, limit = 20): Promise<ReminderRecord[]> {
    const { rows } = await this.db.query<ReminderRow>(
      `UPDATE reminders SET status = 'SENT', sent_at = now(), updated_at = now()
       WHERE id IN (
         SELECT id FROM reminders WHERE status = 'PENDING' AND due_at <= $1 ORDER BY due_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Reconciles a claimed reminder that failed to actually send - claimDue
   * already marked it SENT optimistically (see its own doc comment: it
   * doubles as the concurrency claim), so a real delivery failure must walk
   * that back to FAILED explicitly rather than leave a false SENT record.
   */
  async markFailed(id: string, lastError: string): Promise<void> {
    await this.db.query(
      `UPDATE reminders SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1`,
      [id, lastError],
    );
  }

  /** Only a still-PENDING reminder can be cancelled - one already sent/failed/cancelled is a terminal, honest record of what actually happened. */
  async cancel(id: string, businessId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE reminders SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND business_id = $2 AND status = 'PENDING'`,
      [id, businessId],
    );
    return (rowCount ?? 0) > 0;
  }
}
