import { randomUUID } from 'node:crypto';
import type { Queryable } from './types.js';
import type { ConversationFact } from './conversationStateRepository.js';

export interface CustomerMemoryRecord {
  id: string;
  businessId: string;
  customerId: string;
  confirmedFacts: ConversationFact[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface CustomerMemoryRow {
  id: string;
  business_id: string;
  customer_id: string;
  confirmed_facts: ConversationFact[];
  version: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: CustomerMemoryRow): CustomerMemoryRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    customerId: row.customer_id,
    confirmedFacts: row.confirmed_facts,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A valid-shaped, non-persisted CustomerMemoryRecord for a customer with no memory row yet - mirrors emptyConversationState()'s own reasoning: reading context must never have the side effect of creating a row. */
export function emptyCustomerMemory(businessId: string, customerId: string): CustomerMemoryRecord {
  const now = new Date().toISOString();
  return { id: randomUUID(), businessId, customerId, confirmedFacts: [], version: 1, createdAt: now, updatedAt: now };
}

/** Thrown by update() when expectedVersion no longer matches the stored row - the caller must re-read and retry, never assume its write applied. */
export class CustomerMemoryConflictError extends Error {
  constructor(businessId: string, customerId: string, expectedVersion: number) {
    super(`Customer memory for customer ${customerId} (business ${businessId}) was not at version ${expectedVersion} - re-read and retry`);
    this.name = 'CustomerMemoryConflictError';
  }
}

/**
 * Layer 2 of "layered memory" - see migration 959's own doc comment. Same
 * find/getOrCreate/update(CAS) shape as ConversationStateRepository,
 * scoped to customerId (the channel-agnostic identity migration 928
 * resolves) instead of chatId, so facts confirmed in one conversation can
 * outlive it for the next one with the same customer.
 */
export class CustomerMemoryRepository {
  constructor(private readonly db: Queryable) {}

  async find(businessId: string, customerId: string): Promise<CustomerMemoryRecord | null> {
    const { rows } = await this.db.query<CustomerMemoryRow>(
      `SELECT * FROM customer_memory WHERE business_id = $1 AND customer_id = $2`,
      [businessId, customerId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Idempotent: a customer that already has memory gets it back unchanged; one that doesn't gets a fresh, empty row. Never overwrites an existing row. */
  async getOrCreate(businessId: string, customerId: string): Promise<CustomerMemoryRecord> {
    const existing = await this.find(businessId, customerId);
    if (existing) return existing;

    const { rows } = await this.db.query<CustomerMemoryRow>(
      `INSERT INTO customer_memory (business_id, customer_id)
       VALUES ($1, $2)
       ON CONFLICT (business_id, customer_id) DO NOTHING
       RETURNING *`,
      [businessId, customerId],
    );
    if (rows[0]) return toRecord(rows[0]);
    const created = await this.find(businessId, customerId);
    if (!created) throw new Error('customer_memory getOrCreate found no row after a conflicting insert');
    return created;
  }

  /** Optimistic-concurrency replace of confirmedFacts - only lands if the row is still at expectedVersion. A conflict throws CustomerMemoryConflictError; the caller re-reads and retries. */
  async update(businessId: string, customerId: string, expectedVersion: number, confirmedFacts: ConversationFact[]): Promise<CustomerMemoryRecord> {
    const { rows } = await this.db.query<CustomerMemoryRow>(
      `UPDATE customer_memory SET confirmed_facts = $4::jsonb, version = version + 1, updated_at = now()
       WHERE business_id = $1 AND customer_id = $2 AND version = $3
       RETURNING *`,
      [businessId, customerId, expectedVersion, JSON.stringify(confirmedFacts)],
    );
    const row = rows[0];
    if (!row) throw new CustomerMemoryConflictError(businessId, customerId, expectedVersion);
    return toRecord(row);
  }
}
