import type { Queryable } from './types.js';

export interface UsageCounterRecord {
  id: string;
  businessId: string;
  metricKey: string;
  periodStart: string;
  periodEnd: string;
  count: number;
}

interface UsageCounterRow {
  id: string;
  business_id: string;
  metric_key: string;
  period_start: string;
  period_end: string;
  count: number;
}

function toRecord(row: UsageCounterRow): UsageCounterRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    metricKey: row.metric_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    count: row.count,
  };
}

export class UsageCounterRepository {
  constructor(private readonly db: Queryable) {}

  async increment(
    businessId: string,
    metricKey: string,
    periodStart: string,
    periodEnd: string,
    by = 1,
  ): Promise<UsageCounterRecord> {
    const { rows } = await this.db.query<UsageCounterRow>(
      `INSERT INTO usage_counters (business_id, metric_key, period_start, period_end, count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, metric_key, period_start)
       DO UPDATE SET count = usage_counters.count + EXCLUDED.count, updated_at = now()
       RETURNING *`,
      [businessId, metricKey, periodStart, periodEnd, by],
    );
    const row = rows[0];
    if (!row) throw new Error('usage_counters upsert returned no row');
    return toRecord(row);
  }

  async getCount(businessId: string, metricKey: string, periodStart: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>(
      'SELECT count FROM usage_counters WHERE business_id = $1 AND metric_key = $2 AND period_start = $3',
      [businessId, metricKey, periodStart],
    );
    return rows[0]?.count ?? 0;
  }
}
