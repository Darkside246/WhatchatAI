import type { Queryable } from './types.js';

export interface EmailNoteRecord {
  id: string;
  businessId: string;
  userId: string;
  body: string;
  /** When set, this note doubles as a "reminder" in the tools panel - sorted soonest-first, nothing is ever sent anywhere for it (see migration 992's own comment on why this replaces trying to reuse the WhatsApp-only reminders table). */
  remindAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EmailNoteRow {
  id: string;
  business_id: string;
  user_id: string;
  body: string;
  remind_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: EmailNoteRow): EmailNoteRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    body: row.body,
    remindAt: row.remind_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Email Redesign Phase C: the tools panel's plain "notes to self" card
 * (and, via remindAt, its "Reminders" card too) - no concept like this
 * existed anywhere in this app before. RLS'd (migration 992) - always
 * construct with queryAsTenant(businessId), never the bare pool, or every
 * query silently returns zero rows.
 */
export class EmailNotesRepository {
  constructor(private readonly db: Queryable) {}

  async list(businessId: string, userId: string, limit = 50): Promise<EmailNoteRecord[]> {
    const { rows } = await this.db.query<EmailNoteRow>(
      `SELECT * FROM email_notes WHERE business_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [businessId, userId, limit],
    );
    return rows.map(toRecord);
  }

  /** Notes with a real due date, soonest first - the Reminders card's own query. */
  async listUpcomingReminders(businessId: string, userId: string, limit = 20): Promise<EmailNoteRecord[]> {
    const { rows } = await this.db.query<EmailNoteRow>(
      `SELECT * FROM email_notes WHERE business_id = $1 AND user_id = $2 AND remind_at IS NOT NULL ORDER BY remind_at ASC LIMIT $3`,
      [businessId, userId, limit],
    );
    return rows.map(toRecord);
  }

  async create(businessId: string, userId: string, body: string, remindAt?: string | null): Promise<EmailNoteRecord> {
    const { rows } = await this.db.query<EmailNoteRow>(
      `INSERT INTO email_notes (business_id, user_id, body, remind_at) VALUES ($1, $2, $3, $4) RETURNING *`,
      [businessId, userId, body, remindAt ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('email_notes insert returned no row');
    return toRecord(row);
  }

  async delete(businessId: string, userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM email_notes WHERE id = $1 AND business_id = $2 AND user_id = $3`,
      [id, businessId, userId],
    );
    return (rowCount ?? 0) > 0;
  }
}
