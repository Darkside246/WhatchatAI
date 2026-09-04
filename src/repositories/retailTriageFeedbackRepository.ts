import type { Queryable } from './types.js';

export interface RetailTriageFeedbackRow {
  id: string;
  businessId: string;
  actionRequestId: string | null;
  messageText: string;
  aiCategory: string;
  aiUrgency: string;
  aiConfidence: number;
  humanDecision: 'APPROVED' | 'REJECTED';
  decisionReason: string | null;
  createdAt: Date;
}

export class RetailTriageFeedbackRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: Omit<RetailTriageFeedbackRow, 'id' | 'createdAt'>): Promise<void> {
    await this.db.query(
      `INSERT INTO retail_triage_feedback
         (id, business_id, action_request_id, message_text, ai_category, ai_urgency, ai_confidence, human_decision, decision_reason)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.businessId,
        input.actionRequestId ?? null,
        input.messageText,
        input.aiCategory,
        input.aiUrgency,
        input.aiConfidence,
        input.humanDecision,
        input.decisionReason ?? null,
      ],
    );
  }

  async getRecentExamples(businessId: string, limit = 8): Promise<RetailTriageFeedbackRow[]> {
    const { rows } = await this.db.query<RetailTriageFeedbackRow>(
      `SELECT id,
              business_id AS "businessId",
              action_request_id AS "actionRequestId",
              message_text AS "messageText",
              ai_category AS "aiCategory",
              ai_urgency AS "aiUrgency",
              ai_confidence AS "aiConfidence",
              human_decision AS "humanDecision",
              decision_reason AS "decisionReason",
              created_at AS "createdAt"
       FROM retail_triage_feedback
       WHERE business_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [businessId, limit],
    );
    return rows;
  }
}
