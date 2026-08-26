import type { Pool, Queryable } from './types.js';
import type { AuditEvent } from '../domain/platform/contracts.js';

export class PlatformAuditRepository {
  constructor(private readonly db: Queryable) {}

  async append(event: AuditEvent): Promise<AuditEvent> {
    const { rows } = await this.db.query<AuditEvent>(
      `INSERT INTO platform_audit_events
       (id,business_id,sequence,event_type,actor_kind,actor_id,correlation_id,action_request_id,payload,payload_hash,previous_hash,occurred_at,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)
       RETURNING id,business_id AS "tenantId",sequence,event_type AS "eventType",actor_kind AS "actorKind",actor_id AS "actorId",correlation_id AS "correlationId",action_request_id AS "actionRequestId",payload,payload_hash AS "payloadHash",previous_hash AS "previousHash",occurred_at AS "occurredAt",metadata`,
      [event.id, event.tenantId, 1, event.eventType, event.actor.kind, event.actor.id, event.correlationId, event.actionRequestId ?? null, JSON.stringify(event.payload), event.payloadHash, event.previousHash ?? null, event.occurredAt, JSON.stringify(event.metadata ?? {})],
    );
    if (!rows[0]) throw new Error('platform audit insert returned no row');
    return rows[0];
  }

  async list(tenantId: string, limit = 500): Promise<AuditEvent[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 5000);
    const { rows } = await this.db.query<AuditEvent>(
      `SELECT id,business_id AS "tenantId",sequence,event_type AS "eventType",actor_kind AS "actorKind",actor_id AS "actorId",correlation_id AS "correlationId",action_request_id AS "actionRequestId",payload,payload_hash AS "payloadHash",previous_hash AS "previousHash",occurred_at AS "occurredAt",metadata
       FROM platform_audit_events WHERE business_id = $1 ORDER BY sequence DESC LIMIT $2`,
      [tenantId, bounded],
    );
    return rows.reverse().map((row) => ({
      ...row,
      actor: { kind: row.actorKind, id: row.actorId },
    } as unknown as AuditEvent));
  }

  async withBusinessTransaction<T>(pool: Pool, tenantId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tenantId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
