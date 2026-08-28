import type { Pool } from './types.js';
import type { AuditEvent } from '../domain/platform/contracts.js';

interface AuditEventRow {
  id: string; businessId: string; eventType: string;
  actorKind: string; actorId: string;
  correlationId: string; actionRequestId: string | null;
  payload: Record<string, unknown>; payloadHash: string;
  previousHash: string | null; occurredAt: Date;
  metadata: Record<string, unknown>;
}

export class PlatformAuditLedgerRepository {
  constructor(private readonly pool: Pool) {}

  async append(businessId: string, event: AuditEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Advisory lock serialises concurrent appends for the same tenant so the
      // sequence number cannot be claimed by two transactions simultaneously.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [businessId]);
      const seqRes = await client.query<{ n: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM platform_audit_events WHERE business_id = $1`,
        [businessId],
      );
      const sequence = parseInt(seqRes.rows[0]?.n ?? '1', 10);
      await client.query(
        `INSERT INTO platform_audit_events
           (id, business_id, sequence, event_type, actor_kind, actor_id,
            correlation_id, action_request_id, payload, payload_hash,
            previous_hash, occurred_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)
         ON CONFLICT (business_id, id) DO NOTHING`,
        [
          event.id, businessId, sequence, event.eventType,
          event.actor.kind, event.actor.id, event.correlationId,
          event.actionRequestId ?? null,
          JSON.stringify(event.payload), event.payloadHash,
          event.previousHash ?? null, new Date(event.occurredAt),
          JSON.stringify(event.metadata ?? {}),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listByTenant(businessId: string): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query<AuditEventRow>(
      `SELECT id, business_id AS "businessId", event_type AS "eventType",
              actor_kind AS "actorKind", actor_id AS "actorId",
              correlation_id AS "correlationId", action_request_id AS "actionRequestId",
              payload, payload_hash AS "payloadHash", previous_hash AS "previousHash",
              occurred_at AS "occurredAt", metadata
       FROM platform_audit_events
       WHERE business_id = $1
       ORDER BY sequence ASC`,
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: businessId,
      eventType: row.eventType,
      actor: { kind: row.actorKind as AuditEvent['actor']['kind'], id: row.actorId },
      correlationId: row.correlationId,
      ...(row.actionRequestId !== null ? { actionRequestId: row.actionRequestId } : {}),
      payload: row.payload,
      payloadHash: row.payloadHash,
      ...(row.previousHash !== null ? { previousHash: row.previousHash } : {}),
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
      ...(Object.keys(row.metadata ?? {}).length > 0 ? { metadata: row.metadata } : {}),
    }));
  }
}
