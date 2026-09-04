import type { Queryable } from './types.js';

export const NOTIFICATION_TYPES = [
  'HUMAN_HANDOFF',
  'NEW_MESSAGE',
  'NEW_LEAD',
  'MENTION',
  'ASSIGNMENT',
  'AI_FAILURE',
  'AUTOMATION_FAILURE',
  'SYNC_FAILURE',
  'PAYMENT_ISSUE',
  'CALL',
  'STATUS',
  'SLA_BREACH',
  'SECURITY_ALERT',
  'CAMPAIGN_FAILURE',
  'SYSTEM',
  'AI_BUDGET_EXCEEDED',
  'AI_TOKENS_ADDED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationRecord {
  id: string;
  businessId: string;
  userId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
}

interface NotificationRow {
  id: string;
  business_id: string;
  user_id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  target_type: string | null;
  target_id: string | null;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    targetType: row.target_type,
    targetId: row.target_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

export interface CreateNotificationInput {
  businessId: string;
  userId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  targetType?: string | null;
  targetId?: string | null;
}

export class NotificationRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const { rows } = await this.db.query<NotificationRow>(
      `INSERT INTO notifications (business_id, user_id, type, severity, title, body, target_type, target_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.businessId,
        input.userId,
        input.type,
        input.severity,
        input.title,
        input.body ?? null,
        input.targetType ?? null,
        input.targetId ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('notifications insert returned no row');
    return toRecord(row);
  }

  async listForUser(businessId: string, userId: string, limit = 50): Promise<NotificationRecord[]> {
    const { rows } = await this.db.query<NotificationRow>(
      `SELECT * FROM notifications
       WHERE business_id = $1 AND user_id = $2 AND dismissed_at IS NULL
       ORDER BY created_at DESC
       LIMIT $3`,
      [businessId, userId, limit],
    );
    return rows.map(toRecord);
  }

  async countUnread(businessId: string, userId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications
       WHERE business_id = $1 AND user_id = $2 AND read_at IS NULL AND dismissed_at IS NULL`,
      [businessId, userId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  async findById(id: string): Promise<NotificationRecord | null> {
    const { rows } = await this.db.query<NotificationRow>('SELECT * FROM notifications WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Owner-scoped lookup - a notification id belonging to another user
   * returns null, identically to a genuinely nonexistent id. This is the
   * real ownership boundary the app enforces for notifications (stricter
   * than business-level - one member never sees another member's
   * notification row, even within the same business), so this scopes by
   * userId, not businessId. Prefer this over the bare findById() for any
   * caller that has a userId in scope.
   */
  async findByIdForUser(id: string, userId: string): Promise<NotificationRecord | null> {
    const { rows } = await this.db.query<NotificationRow>(
      'SELECT * FROM notifications WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markRead(id: string): Promise<NotificationRecord | null> {
    const { rows } = await this.db.query<NotificationRow>(
      `UPDATE notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL RETURNING *`,
      [id],
    );
    if (rows[0]) return toRecord(rows[0]);
    return this.findById(id);
  }

  async markDismissed(id: string): Promise<NotificationRecord | null> {
    const { rows } = await this.db.query<NotificationRow>(
      `UPDATE notifications SET dismissed_at = now(), read_at = COALESCE(read_at, now()) WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * The "mark all read" action clears the whole visible inbox, not just
   * the unread rows within it - same dismissed_at + read_at pairing as
   * the single-row markDismissed above, just bulk. Nothing is deleted:
   * every row stays in the table as real history, it just no longer
   * matches listForUser's `dismissed_at IS NULL` filter. Note: title/body
   * are still stored as plain TEXT today, not through EncryptionService -
   * encrypting them at rest is real, separate work, tracked in
   * docs/ARCHITECTURE_STATUS.md's backlog, not part of this change.
   */
  async dismissAllForUser(businessId: string, userId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now()), dismissed_at = now()
       WHERE business_id = $1 AND user_id = $2 AND dismissed_at IS NULL`,
      [businessId, userId],
    );
    return rowCount ?? 0;
  }
}
