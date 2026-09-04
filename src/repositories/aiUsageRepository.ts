import type { Queryable } from './types.js';

export type AiUsageCallKind = 'primary' | 'bare_retry' | 'tool_follow_up' | 'fallback';

export interface RecordAiUsageInput {
  businessId: string;
  agentId?: string | null;
  chatId?: string | null;
  model: string;
  callKind: AiUsageCallKind;
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
}

export interface AiUsageBusinessSummary {
  businessId: string;
  businessName: string;
  totalTokens: number;
  callCount: number;
}

export class AiUsageRepository {
  constructor(private readonly db: Queryable) {}

  /** Never throws into the caller - a failure to record usage telemetry must never turn an otherwise-successful AI reply into a failed one. Log and swallow at the call site, not here (keeps this a plain, honestly-typed insert). */
  async record(input: RecordAiUsageInput): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_usage_events (business_id, agent_id, chat_id, model, call_kind, prompt_tokens, candidates_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.businessId,
        input.agentId ?? null,
        input.chatId ?? null,
        input.model,
        input.callKind,
        input.promptTokens,
        input.candidatesTokens,
        input.totalTokens,
      ],
    );
  }

  /** Real per-business totals over a rolling window, most-usage-first - the "top businesses by AI cost" view. */
  async getTopBusinessesByUsage(sinceHours: number, limit = 10): Promise<AiUsageBusinessSummary[]> {
    const { rows } = await this.db.query<{ business_id: string; business_name: string; total_tokens: string; call_count: string }>(
      `SELECT u.business_id, b.name AS business_name, COALESCE(sum(u.total_tokens), 0) AS total_tokens, count(*) AS call_count
       FROM ai_usage_events u
       JOIN businesses b ON b.id = u.business_id
       WHERE u.created_at > now() - ($1 || ' hours')::interval
       GROUP BY u.business_id, b.name
       ORDER BY total_tokens DESC
       LIMIT $2`,
      [sinceHours, limit],
    );
    return rows.map((row) => ({ businessId: row.business_id, businessName: row.business_name, totalTokens: Number(row.total_tokens), callCount: Number(row.call_count) }));
  }

  /** Real platform-wide totals over a rolling window - the headline number for the developer control plane. */
  async getPlatformTotal(sinceHours: number): Promise<{ totalTokens: number; callCount: number }> {
    const { rows } = await this.db.query<{ total_tokens: string; call_count: string }>(
      `SELECT COALESCE(sum(total_tokens), 0) AS total_tokens, count(*) AS call_count
       FROM ai_usage_events
       WHERE created_at > now() - ($1 || ' hours')::interval`,
      [sinceHours],
    );
    return { totalTokens: Number(rows[0]?.total_tokens ?? 0), callCount: Number(rows[0]?.call_count ?? 0) };
  }

  /**
   * One real business's usage for the current calendar month (UTC, not a
   * rolling 30-day window) - the number entitlementService.canUseAiThisMonth()
   * compares against the plan's max_ai_tokens_per_month limit. Resets
   * naturally on the 1st of each month with no separate reset job needed,
   * the same way a real monthly billing cycle would.
   *
   * A real bug lived here: this doc comment always claimed "UTC via
   * date_trunc", but date_trunc('month', now()) truncates in the session's
   * timezone, not UTC, unless told otherwise - on a server whose session
   * timezone isn't UTC (found live: America/Blanc-Sablon), the monthly
   * counter would reset up to several hours early or late relative to the
   * true UTC month boundary this plan limit is meant to track. AT TIME
   * ZONE 'UTC' makes the SQL actually match what was always documented.
   */
  async getMonthlyTotalForBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ total_tokens: string }>(
      `SELECT COALESCE(sum(total_tokens), 0) AS total_tokens
       FROM ai_usage_events
       WHERE business_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [businessId],
    );
    return Number(rows[0]?.total_tokens ?? 0);
  }
}
