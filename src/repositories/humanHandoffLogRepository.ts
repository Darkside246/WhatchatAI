import { getEncryptionService } from '../security/encryption/index.js';
import type { Queryable } from './types.js';

/**
 * The reasons a conversation can be taken from the AI. These mirror
 * whatsapp_chats.ai_mode_source exactly, so the log and the chat row can
 * never describe the same event differently.
 */
export type HandoffReason =
  | 'no_agent'
  | 'blocked_keyword'
  | 'ai_unavailable'
  | 'output_leak_blocked'
  | 'ai_to_ai_loop_prevented'
  | 'manual_reply_detected'
  | 'operator_pause';

/** Plain-English text for each reason. Kept here, next to the tokens, so the UI cannot drift from the real meaning. */
export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  no_agent: 'No AI agent matched this message',
  blocked_keyword: 'A blocked keyword matched',
  ai_unavailable: 'The AI was unavailable',
  output_leak_blocked: 'The reply was withheld by the outbound leak guard',
  ai_to_ai_loop_prevented: 'The other side is another AI account - loop prevented',
  manual_reply_detected: 'A person replied from the phone',
  operator_pause: 'The operator paused the AI',
};

export interface HumanHandoffLogEntry {
  id: string;
  businessId: string;
  chatId: string;
  messageId: string | null;
  reason: HandoffReason | string;
  reasonDetail: string | null;
  customerLabel: string | null;
  customerPhone: string | null;
  messageExcerpt: string | null;
  createdAt: string;
}

interface HandoffLogRow {
  id: string;
  business_id: string;
  chat_id: string;
  message_id: string | null;
  reason: string;
  reason_detail: string | null;
  customer_label: string | null;
  customer_phone: string | null;
  message_excerpt: string | null;
  created_at: string;
}

export interface RecordHandoffInput {
  businessId: string;
  chatId: string;
  messageId?: string | null;
  reason: HandoffReason;
  reasonDetail?: string | null;
  customerLabel?: string | null;
  customerPhone?: string | null;
  messageExcerpt?: string | null;
}

/**
 * How much of the triggering message is kept. Enough to recognise what the
 * customer actually said without storing a second full copy of every
 * message - the real body stays in whatsapp_messages, referenced by
 * message_id. See migration 1013's own note on size.
 */
export const EXCERPT_MAX_CHARS = 280;

function truncateExcerpt(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= EXCERPT_MAX_CHARS ? trimmed : `${trimmed.slice(0, EXCERPT_MAX_CHARS - 1)}…`;
}

/**
 * Decrypts one envelope field, degrading to an honest "unavailable" marker
 * rather than failing the whole read - same reasoning as
 * whatsappMessageRepository's own decryptTextContent: a single row
 * encrypted under a retired master key must never take down the entire log
 * (Promise.all rejects on the first failure), and the loss is logged loudly
 * rather than silently hidden.
 */
async function decryptField(businessId: string, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const envelope = getEncryptionService().tryParse(value);
  if (!envelope) return value;
  try {
    return await getEncryptionService().decryptField(businessId, envelope);
  } catch (error) {
    console.error(
      `[humanHandoffLogRepository] Failed to decrypt a handoff log field for business ${businessId} - ` +
        'the row was likely encrypted under a different MASTER_ENCRYPTION_KEY than is currently configured.',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function encryptField(businessId: string, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const envelope = await getEncryptionService().encryptField(businessId, value);
  return getEncryptionService().serialize(envelope);
}

async function toEntry(row: HandoffLogRow): Promise<HumanHandoffLogEntry> {
  const [reasonDetail, customerLabel, customerPhone, messageExcerpt] = await Promise.all([
    decryptField(row.business_id, row.reason_detail),
    decryptField(row.business_id, row.customer_label),
    decryptField(row.business_id, row.customer_phone),
    decryptField(row.business_id, row.message_excerpt),
  ]);

  return {
    id: row.id,
    businessId: row.business_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    reason: row.reason,
    reasonDetail,
    customerLabel,
    customerPhone,
    messageExcerpt,
    createdAt: row.created_at,
  };
}

export class HumanHandoffLogRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Appends one real handoff event. Every personal-data field is encrypted
   * under this tenant's own key before it touches the database; reason and
   * created_at stay plaintext because they carry no personal data and are
   * what the list is filtered and sorted by.
   */
  async record(input: RecordHandoffInput): Promise<HumanHandoffLogEntry> {
    const [reasonDetail, customerLabel, customerPhone, messageExcerpt] = await Promise.all([
      encryptField(input.businessId, input.reasonDetail ?? null),
      encryptField(input.businessId, input.customerLabel ?? null),
      encryptField(input.businessId, input.customerPhone ?? null),
      encryptField(input.businessId, truncateExcerpt(input.messageExcerpt)),
    ]);

    const { rows } = await this.db.query<HandoffLogRow>(
      `INSERT INTO human_handoff_log
         (business_id, chat_id, message_id, reason, reason_detail, customer_label, customer_phone, message_excerpt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.businessId,
        input.chatId,
        input.messageId ?? null,
        input.reason,
        reasonDetail,
        customerLabel,
        customerPhone,
        messageExcerpt,
      ],
    );

    return toEntry(rows[0]!);
  }

  /** Newest first. Tenant-scoped, and bounded so one enormous log can never be fetched in a single response. */
  async list(businessId: string, limit = 200, offset = 0): Promise<HumanHandoffLogEntry[]> {
    const { rows } = await this.db.query<HandoffLogRow>(
      `SELECT * FROM human_handoff_log
        WHERE business_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [businessId, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)],
    );
    return Promise.all(rows.map(toEntry));
  }

  async count(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM human_handoff_log WHERE business_id = $1',
      [businessId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Deletes one entry. Returns false when it does not exist for this business, so a caller can 404 honestly rather than reporting a delete that never happened. */
  async deleteEntry(businessId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM human_handoff_log WHERE business_id = $1 AND id = $2',
      [businessId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Clears the whole log for this business. Returns how many rows were really removed. */
  async clear(businessId: string): Promise<number> {
    const { rowCount } = await this.db.query('DELETE FROM human_handoff_log WHERE business_id = $1', [businessId]);
    return rowCount ?? 0;
  }
}
