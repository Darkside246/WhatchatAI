import { Pool } from 'pg';

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
