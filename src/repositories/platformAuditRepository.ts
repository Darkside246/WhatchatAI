import type { Pool, Queryable } from './types.js';
import type { AuditEvent } from '../domain/platform/contracts.js';

type AuditRow = {
  id: string; tenantId: string; sequence: number; eventType: string; actorKind: AuditEvent['actor']['kind']; actorId: string;
  correlationId: string; actionRequestId: string | null; payload: Record<string, unknown>; payloadHash: string; previousHash: string | null; occurredAt: string; metadata: Record<string, unknown>;
};

function toAuditEvent(row: AuditRow): AuditEvent {
  const event: AuditEvent = {
    id: row.id, tenantId: row.tenantId, eventType: row.eventType,
    actor: { kind: row.actorKind, id: row.actorId }, correlationId: row.correlationId,
    payload: row.payload, payloadHash: row.payloadHash, occurredAt: row.occurredAt,
  };
  if (row.actionRequestId !== null) event.actionRequestId = row.actionRequestId;
  if (row.previousHash !== null) event.previousHash = row.previousHash;
  if (Object.keys(row.metadata).length > 0) event.metadata = row.metadata;
  return event;
}

const COLUMNS = `id,business_id AS "tenantId",sequence,event_type AS "eventType",actor_kind AS "actorKind",actor_id AS "actorId",correlation_id AS "correlationId",action_request_id AS "actionRequestId",payload,payload_hash AS "payloadHash",previous_hash AS "previousHash",occurred_at AS "occurredAt",metadata`;

export class PlatformAuditRepository {
  constructor(private readonly db: Queryable) {}

  async append(pool: Pool, event: AuditEvent): Promise<AuditEvent> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [event.tenantId]);
      const prior = await client.query<{ sequence: number; payload_hash: string }>(
        `SELECT sequence,payload_hash FROM platform_audit_events WHERE business_id = $1 ORDER BY sequence DESC LIMIT 1`,
        [event.tenantId],
      );
      const previous = prior.rows[0];
      const sequence = (previous?.sequence ?? 0) + 1;
      const previousHash = previous?.payload_hash ?? null;
      const row = await client.query<AuditRow>(
        `INSERT INTO platform_audit_events (id,business_id,sequence,event_type,actor_kind,actor_id,correlation_id,action_request_id,payload,payload_hash,previous_hash,occurred_at,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb) RETURNING ${COLUMNS}`,
        [event.id,event.tenantId,sequence,event.eventType,event.actor.kind,event.actor.id,event.correlationId,event.actionRequestId ?? null,JSON.stringify(event.payload),event.payloadHash,previousHash,event.occurredAt,JSON.stringify(event.metadata ?? {})],
      );
      if (!row.rows[0]) throw new Error('platform audit insert returned no row');
      await client.query('COMMIT');
      return toAuditEvent(row.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(tenantId: string, limit = 500): Promise<AuditEvent[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 5000);
    const { rows } = await this.db.query<AuditRow>(`SELECT ${COLUMNS} FROM platform_audit_events WHERE business_id = $1 ORDER BY sequence DESC LIMIT $2`, [tenantId,bounded]);
    return rows.reverse().map(toAuditEvent);
  }
}
