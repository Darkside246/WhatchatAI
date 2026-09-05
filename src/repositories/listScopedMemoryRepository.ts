import { randomUUID } from 'node:crypto';
import type { Queryable } from './types.js';
import type { ConversationFact } from './conversationStateRepository.js';

export interface ListScopedMemoryRecord {
  id: string;
  businessId: string;
  listId: string;
  customerId: string;
  confirmedFacts: ConversationFact[];
  preferredName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ListScopedMemoryRow {
  id: string;
  business_id: string;
  list_id: string;
  customer_id: string;
  confirmed_facts: ConversationFact[];
  preferred_name: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ListScopedMemoryRow): ListScopedMemoryRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    listId: row.list_id,
    customerId: row.customer_id,
    confirmedFacts: row.confirmed_facts,
    preferredName: row.preferred_name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A valid-shaped, non-persisted ListScopedMemoryRecord for a customer with no list-scoped memory row yet under this List - mirrors emptyCustomerMemory()'s own reasoning: reading context must never have the side effect of creating a row. */
export function emptyListScopedMemory(businessId: string, listId: string, customerId: string): ListScopedMemoryRecord {
  const now = new Date().toISOString();
  return { id: randomUUID(), businessId, listId, customerId, confirmedFacts: [], preferredName: null, version: 1, createdAt: now, updatedAt: now };
}

export class ListScopedMemoryConflictError extends Error {
  constructor(businessId: string, listId: string, customerId: string, expectedVersion: number) {
    super(`List-scoped memory for customer ${customerId} under list ${listId} (business ${businessId}) was not at version ${expectedVersion} - re-read and retry`);
    this.name = 'ListScopedMemoryConflictError';
  }
}

/**
 * AURA Lists (Phase 1): THE hard-must isolation mechanism. Deliberately
 * mirrors customerMemoryRepository.ts method-for-method, but every method
 * here requires `listId` as a non-optional positional parameter - there is
 * no method in this file that can read or write a customer's memory
 * without naming exactly one list. The same real person (same customerId)
 * under two different listIds is, by construction, two disjoint rows: a
 * find() call scoped to "Work" structurally cannot see what was written
 * under "Friends" for that identical customerId, and there is no
 * cross-list query anywhere in this file to bypass that. RLS'd
 * (migration 997) - always construct with queryAsTenant(businessId).
 */
export class ListScopedMemoryRepository {
  constructor(private readonly db: Queryable) {}

  async find(businessId: string, listId: string, customerId: string): Promise<ListScopedMemoryRecord | null> {
    const { rows } = await this.db.query<ListScopedMemoryRow>(
      `SELECT * FROM list_scoped_memory WHERE business_id = $1 AND list_id = $2 AND customer_id = $3`,
      [businessId, listId, customerId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Idempotent: a customer that already has memory under this List gets it back unchanged; one that doesn't gets a fresh, empty row. Never overwrites an existing row. */
  async getOrCreate(businessId: string, listId: string, customerId: string): Promise<ListScopedMemoryRecord> {
    const existing = await this.find(businessId, listId, customerId);
    if (existing) return existing;

    const { rows } = await this.db.query<ListScopedMemoryRow>(
      `INSERT INTO list_scoped_memory (business_id, list_id, customer_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, list_id, customer_id) DO NOTHING
       RETURNING *`,
      [businessId, listId, customerId],
    );
    if (rows[0]) return toRecord(rows[0]);
    const created = await this.find(businessId, listId, customerId);
    if (!created) throw new Error('list_scoped_memory getOrCreate found no row after a conflicting insert');
    return created;
  }

  /** Optimistic-concurrency patch - identical CAS shape to customerMemoryRepository.update. */
  async update(
    businessId: string,
    listId: string,
    customerId: string,
    expectedVersion: number,
    patch: { confirmedFacts?: ConversationFact[]; preferredName?: string | null },
  ): Promise<ListScopedMemoryRecord> {
    const preferredNameTouched = patch.preferredName !== undefined;
    const { rows } = await this.db.query<ListScopedMemoryRow>(
      `UPDATE list_scoped_memory SET
         confirmed_facts = COALESCE($5::jsonb, confirmed_facts),
         preferred_name = CASE WHEN $7 THEN $6 ELSE preferred_name END,
         version = version + 1, updated_at = now()
       WHERE business_id = $1 AND list_id = $2 AND customer_id = $3 AND version = $4
       RETURNING *`,
      [businessId, listId, customerId, expectedVersion, patch.confirmedFacts ? JSON.stringify(patch.confirmedFacts) : null, patch.preferredName ?? null, preferredNameTouched],
    );
    const row = rows[0];
    if (!row) throw new ListScopedMemoryConflictError(businessId, listId, customerId, expectedVersion);
    return toRecord(row);
  }

  /** Erasure under exactly one List - deliberately cannot erase a customer's memory across every List they happen to appear in with a single call, matching this file's own "always name exactly one list" rule. */
  async deleteByListAndCustomer(businessId: string, listId: string, customerId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM list_scoped_memory WHERE business_id = $1 AND list_id = $2 AND customer_id = $3`,
      [businessId, listId, customerId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
