import { createHash } from 'node:crypto';
import type { Pool } from './types.js';

/**
 * Kept in sync by hand with the CHECK constraint in
 * 930_create_conversation_events.sql - see that migration's comment on
 * why a drifted CHECK list is a real, previously-hit bug in this repo
 * (migration 927), not a hypothetical one.
 */
export type ConversationEventType =
  | 'conversation_created'
  | 'message_received'
  | 'message_sent'
  | 'goal_updated'
  | 'fact_confirmed'
  | 'question_opened'
  | 'question_resolved'
  | 'state_updated'
  | 'channel_session_started'
  | 'channel_session_ended'
  | 'handoff_requested'
  | 'action_proposed'
  | 'action_approved'
  | 'action_executed';

export interface ConversationEventRecord {
  id: string;
  businessId: string;
  chatId: string;
  sequence: number;
  eventType: ConversationEventType;
  payload: Record<string, unknown>;
  payloadHash: string;
  previousHash: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

interface ConversationEventRow {
  id: string;
  business_id: string;
  chat_id: string;
  sequence: number;
  event_type: ConversationEventType;
  payload: Record<string, unknown>;
  payload_hash: string;
  previous_hash: string | null;
  // node-postgres returns TIMESTAMPTZ as a real Date instance by default,
  // not a string - and Date has no own enumerable keys, so passing one
  // straight into canonical() below would silently hash it as "{}",
  // making verify() spuriously fail on every row read back from the
  // database. Always normalize to an ISO string at the repository
  // boundary (matching platformAuditLedgerRepository's own handling of
  // the same column type) before it goes anywhere near digest().
  occurred_at: string | Date;
  metadata: Record<string, unknown>;
}

function toRecord(row: ConversationEventRow): ConversationEventRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    chatId: row.chat_id,
    sequence: row.sequence,
    eventType: row.event_type,
    payload: row.payload,
    payloadHash: row.payload_hash,
    previousHash: row.previous_hash,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    metadata: row.metadata,
  };
}

/** Deterministic key-sorted JSON so the same logical event always hashes the same way regardless of property insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function digest(input: Omit<ConversationEventRecord, 'payloadHash' | 'id'>): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

export interface AppendConversationEventInput {
  businessId: string;
  chatId: string;
  eventType: ConversationEventType;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only conversation event stream, independent of AuditLedgerService/
 * platform_audit_events (see the migration's own comment on why). Unlike
 * AuditLedgerService, this repository keeps no in-memory chain cache -
 * every append reads the true previous sequence/hash directly from the
 * database inside the same locked transaction that inserts the new row, so
 * the chain is genuinely durable across process restarts, not just
 * per-process.
 */
export class ConversationEventRepository {
  constructor(private readonly pool: Pool) {}

  async append(input: AppendConversationEventInput): Promise<ConversationEventRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Advisory lock serialises concurrent appends for the same
      // conversation so two transactions can never both claim the next
      // sequence number - the same pattern platformAuditLedgerRepository
      // already proves works, scoped per (business, chat) rather than per
      // business since sequence here is per-conversation.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`${input.businessId}:${input.chatId}`]);

      const { rows: lastRows } = await client.query<{ sequence: number; payload_hash: string }>(
        `SELECT sequence, payload_hash FROM conversation_events
         WHERE business_id = $1 AND chat_id = $2
         ORDER BY sequence DESC LIMIT 1`,
        [input.businessId, input.chatId],
      );
      const last = lastRows[0];
      const sequence = (last?.sequence ?? 0) + 1;
      const previousHash = last?.payload_hash ?? null;
      const payload = input.payload ?? {};
      const metadata = input.metadata ?? {};
      const occurredAt = new Date().toISOString();

      const payloadHash = digest({
        businessId: input.businessId,
        chatId: input.chatId,
        sequence,
        eventType: input.eventType,
        payload,
        previousHash,
        occurredAt,
        metadata,
      });

      const { rows } = await client.query<ConversationEventRow>(
        `INSERT INTO conversation_events
           (business_id, chat_id, sequence, event_type, payload, payload_hash, previous_hash, occurred_at, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)
         RETURNING *`,
        [input.businessId, input.chatId, sequence, input.eventType, JSON.stringify(payload), payloadHash, previousHash, occurredAt, JSON.stringify(metadata)],
      );
      const row = rows[0];
      if (!row) throw new Error('conversation_events insert returned no row');

      await client.query('COMMIT');
      return toRecord(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listByChat(businessId: string, chatId: string): Promise<ConversationEventRecord[]> {
    const { rows } = await this.pool.query<ConversationEventRow>(
      `SELECT * FROM conversation_events WHERE business_id = $1 AND chat_id = $2 ORDER BY sequence ASC`,
      [businessId, chatId],
    );
    return rows.map(toRecord);
  }

  /** Recomputes every event's hash and previousHash linkage from scratch and confirms it matches what's stored - a tampered or corrupted row breaks the chain from that point forward. */
  async verify(businessId: string, chatId: string): Promise<boolean> {
    const events = await this.listByChat(businessId, chatId);
    let expectedPrevious: string | null = null;
    for (const event of events) {
      if (event.previousHash !== expectedPrevious) return false;
      const recomputed = digest({
        businessId: event.businessId,
        chatId: event.chatId,
        sequence: event.sequence,
        eventType: event.eventType,
        payload: event.payload,
        previousHash: event.previousHash,
        occurredAt: event.occurredAt,
        metadata: event.metadata,
      });
      if (recomputed !== event.payloadHash) return false;
      expectedPrevious = event.payloadHash;
    }
    return true;
  }
}
