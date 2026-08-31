import { Pool, types, type QueryResult, type QueryResultRow } from 'pg';

// Every repository in this codebase types timestamp columns as `string`
// (createdAt, updatedAt, lastMessageAt, ...), but pg's default parsers
// convert TIMESTAMPTZ/TIMESTAMP columns to native Date objects. That
// mismatch is silently masked wherever a Date just gets JSON.stringify'd
// (Date -> ISO string happens automatically), but breaks anywhere code
// calls a string method (e.g. .localeCompare) directly on a row field.
// Returning the raw text value keeps every row's runtime shape matching
// its TypeScript type.
// Converted to a proper ISO-8601 string (not pg's raw wire text, which uses
// a space separator and a colon-less UTC offset) - this is byte-identical
// to what Date.prototype.toJSON() already produced everywhere a row's
// timestamp got JSON-serialized, so existing callers see no change.
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const toIsoString = (value: string) => new Date(value).toISOString();
types.setTypeParser(TIMESTAMP_OID, toIsoString);
types.setTypeParser(TIMESTAMPTZ_OID, toIsoString);

const connectionString = process.env.DATABASE_URL;

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// pg emits 'error' on the pool when an idle client's connection drops (e.g. the
// database goes down). Without a listener, Node treats that as an unhandled
// error and crashes the process - the app must stay up and report
// DATABASE_UNAVAILABLE instead of dying.
pool.on('error', (error) => {
  console.error('[db] Idle client error:', error.message);
});

/**
 * A database-enforced backstop for the business_id filter every repository
 * query already applies in application code (see migration 944) - not a
 * replacement for it. `whatchatai` (this pool's own login role) is a
 * Postgres superuser and therefore always bypasses Row-Level Security
 * unconditionally, regardless of policy - a hard Postgres guarantee, not a
 * misconfiguration to fix. Switching to the restricted, non-superuser
 * `whatchatai_tenant` role for the duration of one transaction is what
 * actually makes RLS bind: repository classes only ever call `.query()`
 * through the `Queryable` interface (src/repositories/types.ts), so any
 * repository constructed with the object this returns, instead of the bare
 * `pool`, is transparently tenant-scoped with no change to the repository
 * itself.
 *
 * Deliberately one connection + transaction per call, not a shared
 * multi-query session: correctness here matters far more than shaving a
 * few round trips, and every call site this is used from is already
 * dominated by multi-second LLM latency.
 */
export function queryAsTenant(businessId: string): { query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> } {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE whatchatai_tenant');
        await client.query(`SELECT set_config('app.current_business_id', $1, true)`, [businessId]);
        const result = await client.query<T>(text, params);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export interface DatabaseHealth {
  available: boolean;
  error: string | null;
  checkedAt: string;
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const checkedAt = new Date().toISOString();
  if (!connectionString) {
    return { available: false, error: 'DATABASE_URL is not configured.', checkedAt };
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return { available: true, error: null, checkedAt };
    } finally {
      client.release();
    }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }
}
