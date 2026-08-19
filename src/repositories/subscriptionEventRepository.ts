import type { Queryable } from './types.js';

export interface SubscriptionEventRecord {
  id: string;
  businessId: string;
  subscriptionId: string;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  occurredAt: string;
}

interface SubscriptionEventRow {
  id: string;
  business_id: string;
  subscription_id: string;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  occurred_at: string;
}

function toRecord(row: SubscriptionEventRow): SubscriptionEventRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    occurredAt: row.occurred_at,
  };
}

export class SubscriptionEventRepository {
  constructor(private readonly db: Queryable) {}

  async record(
    businessId: string,
    subscriptionId: string,
    eventType: string,
    previousStatus: string | null,
    newStatus: string | null,
    rawMetadata: Record<string, unknown> = {},
  ): Promise<SubscriptionEventRecord> {
    const { rows } = await this.db.query<SubscriptionEventRow>(
      `INSERT INTO subscription_events (business_id, subscription_id, event_type, previous_status, new_status, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [businessId, subscriptionId, eventType, previousStatus, newStatus, JSON.stringify(rawMetadata)],
    );
    const row = rows[0];
    if (!row) throw new Error('subscription_events insert returned no row');
    return toRecord(row);
  }

  async listBySubscription(subscriptionId: string): Promise<SubscriptionEventRecord[]> {
    const { rows } = await this.db.query<SubscriptionEventRow>(
      'SELECT * FROM subscription_events WHERE subscription_id = $1 ORDER BY occurred_at DESC',
      [subscriptionId],
    );
    return rows.map(toRecord);
  }
}
