import 'dotenv/config';
import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';

export default async function globalSetup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL must be set to a real test database before running tests.');
  }
  if (!connectionString.includes('test')) {
    throw new Error(
      `Refusing to run tests against a database whose name doesn't contain "test": ${connectionString}`,
    );
  }

  const pool = new Pool({ connectionString });
  await runMigrations(pool);
  await pool.end();
}
