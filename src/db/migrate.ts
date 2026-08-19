import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { pool as defaultPool } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function loadMigrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

export async function runMigrations(pool: Pool = defaultPool): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const alreadyApplied = new Set(rows.map((row) => row.id));

    for (const migration of loadMigrationFiles()) {
      if (alreadyApplied.has(migration.name)) continue;

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { applied };
  } finally {
    client.release();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then(({ applied }) => {
      if (applied.length === 0) {
        console.log('[migrate] Already up to date.');
      } else {
        console.log(`[migrate] Applied ${applied.length} migration(s):`);
        for (const name of applied) console.log(`  - ${name}`);
      }
      return defaultPool.end();
    })
    .catch((error) => {
      console.error('[migrate] Failed:', error);
      process.exitCode = 1;
    });
}
