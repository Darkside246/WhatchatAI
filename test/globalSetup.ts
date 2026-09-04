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

/**
 * Same reasoning as MEDIA_STORAGE_DIR above: WHATSAPP_SESSION_DIR from
 * .env points at this machine's real, live-paired WhatsApp session
 * credentials (or, post-migration, the real per-tenant session root). A
 * test run touching that directory - even just to exercise the session-dir
 * containment guard's adversarial cases - must never risk writing into or
 * deleting from it.
 */
const TEST_WHATSAPP_SESSION_DIR = './data/whatsapp-session-test';

/**
 * AURA engineering directive, "Automate Redis test isolation" (2026-09-04):
 * previously a clean Redis state before a run was produced by hand
 * (`redis-cli flushall` run manually before/between invocations) - never
 * automated, and worse, `FLUSHALL` itself was the wrong tool even done by
 * hand: it clears every database index on the Redis server, not just the
 * test-dedicated one, which is unsafe on any Redis instance that also
 * serves a real dev server on index 0.
 *
 * This repo already has a real, enforced dedicated test namespace: the
 * check directly below refuses to even start a test run unless
 * `REDIS_URL`'s database index is non-zero (defaulting to 1). Because
 * Redis database indices are fully separate keyspaces within one server
 * process, that enforcement *is* a legitimate dedicated namespace - so the
 * safe, correct cleanup primitive is `FLUSHDB` (clears only the currently
 * SELECTed index) issued on a connection pinned to that exact index,
 * never `FLUSHALL` (clears the whole server, every index, unconditionally).
 * A dev server's own real jobs on index 0 are never touched by this.
 *
 * Runs once before the whole suite (clears out anything left over from a
 * previous invocation - a stale delayed retry, a job whose consuming
 * worker process already exited, etc. - the exact class of "phantom
 * failure that looks like a real regression" this directive was written
 * to fix) and once more after the whole suite via the returned teardown,
 * so a developer's next `npm run dev` (or the next test run) never
 * inherits anything from this one either.
 */
async function flushTestRedis(url: string): Promise<void> {
  const { Redis } = await import('ioredis');
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false });
  try {
    await client.flushdb();
  } finally {
    await client.quit();
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.MEDIA_STORAGE_DIR = TEST_MEDIA_STORAGE_DIR;
  process.env.WHATSAPP_SESSION_DIR = TEST_WHATSAPP_SESSION_DIR;

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

  const testRedisUrl = process.env.REDIS_URL;
  await flushTestRedis(testRedisUrl);

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

  return async () => {
    await flushTestRedis(testRedisUrl);
  };
}
