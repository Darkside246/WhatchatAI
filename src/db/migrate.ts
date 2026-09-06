import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { pool as defaultPool } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Real, confirmed production bug fixed here: plain .sort() compares
 * filenames as strings, so "1000_x.sql" sorts BEFORE "945_x.sql" through
 * "999_x.sql" - '1' < '9' as the first character. Every migration this
 * session was applied incrementally against dev/test (one at a time, right
 * after being written), so this never had a chance to matter until a
 * production database far behind (944) tried to catch up across the
 * 999->1000 digit-count boundary in one run - 1000_chat_list_engagement.sql
 * attempted before 997_lists_phase1.sql (the migration that creates the
 * "lists" table it depends on), which had sorted after it as a string.
 * Sorting by the real leading integer, not the string, is correct
 * regardless of how many digits any given migration number has.
 */
function migrationNumber(filename: string): number {
  const match = /^(\d+)_/.exec(filename);
  if (!match) throw new Error(`Migration filename "${filename}" doesn't start with a numeric prefix.`);
  return Number(match[1]);
}

function loadMigrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b))
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
