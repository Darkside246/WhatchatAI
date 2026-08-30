import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Redis isolation, applied BEFORE anything imports the queue connection -
 * src/queue/connection.ts reads REDIS_URL once at module load, so this has
 * to happen first and the import below has to be dynamic.
 *
 * Why it matters: BullMQ queues live in the Redis keyspace, so a test run
 * sharing an index with a running `npm run dev` has its jobs consumed by the
 * dev server. That produced failures which looked like real regressions and
 * vanished on a re-run - twice in one session. Tests get their own index.
 */
const DEFAULT_TEST_REDIS_URL = 'redis://127.0.0.1:6379/1';

function redisDatabaseIndex(url: string): number {
  return Number(new URL(url).pathname.replace('/', '')) || 0;
}

/**
 * Media-storage isolation, same reasoning as the Redis isolation below: a
 * test run must never write real files into MEDIA_STORAGE_DIR from .env -
 * that now points at one folder shared between this machine's two
 * checkouts specifically so real dev media is never orphaned from its DB
 * row (see .env's own doc comment). A test run sharing that folder would
 * pollute it with disposable test debris, which is exactly the problem
 * that shared path was introduced to stop happening to *real* media.
 * Unconditionally redirected to a dedicated, checkout-local directory -
 * there is no legitimate reason a test run would want anything else.
 */
const TEST_MEDIA_STORAGE_DIR = './data/media-storage-test';

export default async function globalSetup(): Promise<void> {
  process.env.MEDIA_STORAGE_DIR = TEST_MEDIA_STORAGE_DIR;

  const configured = process.env.REDIS_URL;
  if (!configured || redisDatabaseIndex(configured) === 0) {
    process.env.REDIS_URL = DEFAULT_TEST_REDIS_URL;
  }

  // Dynamic so it picks up the REDIS_URL set immediately above.
  const { queueDatabaseIndex } = await import('../src/queue/connection.js');
  if (queueDatabaseIndex === 0) {
    throw new Error(
      'Refusing to run tests against Redis database index 0, which a dev server may share. ' +
        'Point REDIS_URL at a dedicated index, e.g. redis://127.0.0.1:6379/1',
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL must be set to a real test database before running tests.');
  }
  if (!connectionString.includes('test')) {
    throw new Error(
      `Refusing to run tests against a database whose name doesn't contain "test": ${connectionString}`,
    );
  }

  const { runMigrations } = await import('../src/db/migrate.js');
  const pool = new Pool({ connectionString });
  await runMigrations(pool);
  await pool.end();
}
