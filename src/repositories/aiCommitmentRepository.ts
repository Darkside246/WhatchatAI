import type { Queryable } from './types.js';

export interface AiCommitmentRecord {
  id: string;
  businessId: string;
  chatId: string;
  commitmentText: string;
  detectedPhrase: string;
  createdAt: string;
}

export interface RecordCommitmentInput {
  businessId: string;
  chatId: string;
  commitmentText: string;
  detectedPhrase: string;
}

interface AiCommitmentRow {
  id: string;
  business_id: string;
  chat_id: string;
  commitment_text: string;
  detected_phrase: string;
  created_at: string;
}

function toRecord(row: AiCommitmentRow): AiCommitmentRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    chatId: row.chat_id,
    commitmentText: row.commitment_text,
    detectedPhrase: row.detected_phrase,
    createdAt: row.created_at,
  };
}

export class AiCommitmentRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: RecordCommitmentInput): Promise<AiCommitmentRecord> {
    const { rows } = await this.db.query<AiCommitmentRow>(
      `INSERT INTO ai_commitments (business_id, chat_id, commitment_text, detected_phrase)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.businessId, input.chatId, input.commitmentText, input.detectedPhrase],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_commitments insert returned no row');
    return toRecord(row);
  }

  /**
   * Real, unaddressed commitments older than the given age - "unaddressed"
   * meaning no later outbound message exists in the same chat (a real
   * signal the business did follow up, computed at read time rather than
   * a resolved_at column that would need a background sweep to stay
   * accurate). Never guesses whether a follow-up happened; only trusts
   * a real, later row in whatsapp_messages.
   */
  async listOpen(businessId: string, olderThanHours: number, limit = 50): Promise<AiCommitmentRecord[]> {
    const { rows } = await this.db.query<AiCommitmentRow>(
      `SELECT c.* FROM ai_commitments c
       WHERE c.business_id = $1
         AND c.created_at < now() - ($2 || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_messages m
           WHERE m.chat_id = c.chat_id
             AND m.direction = 'outbound'
             AND m.created_at > c.created_at
         )
       ORDER BY c.created_at ASC
       LIMIT $3`,
      [businessId, olderThanHours, limit],
    );
    return rows.map(toRecord);
  }
}
