/**
 * AURA engineering directive, "Automate Redis test isolation" (2026-09-04),
 * follow-up: globalSetup.ts's flushdb runs exactly ONCE for the whole
 * `vitest run` invocation - but with fileParallelism:false and vitest's
 * default per-file module isolation, EVERY test file gets its own fresh
 * module registry, and so its own fresh `new Worker(...)` instance the
 * moment that file's top-level imports run (src/queue/workers/*.ts
 * construct their Worker/Queue singletons at module load, not lazily). A
 * BullMQ Worker starts pulling jobs from Redis immediately on construction
 * - before any `beforeAll` in that file or a shared helper has a chance to
 * run - so a leftover delayed/waiting job enqueued by the PREVIOUS test
 * file (its own worker.close() in afterAll only waits for currently ACTIVE
 * jobs to finish, never drains queued/delayed ones) gets picked up by the
 * NEXT file's brand new worker and processed against whatever business/
 * account rows that next file's own beforeEach/resetDatabase just wiped -
 * producing exactly the FK-violation and cross-test-interference failures
 * this directive set out to eliminate (confirmed live: a
 * security_audit_logs_whatsapp_account_id_fkey violation with no such
 * error inside any single file run alone).
 *
 * `setupFiles` (unlike `globalSetup`) runs once per test file, in that
 * file's own isolated context, and - critically - BEFORE that file's own
 * top-level code executes, so this flush always lands before any worker in
 * that file has been constructed. Plain top-level await, not a `beforeAll`:
 * a hook would already run too late, after the file's own module-level
 * `new Worker(...)` call already started consuming.
 */
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL must be set before test/setupFile.ts runs - globalSetup.ts is expected to set it.');
}
// Same enforced-dedicated-index safety as globalSetup.ts's flushTestRedis -
// never flush index 0, which a dev server may share.
const databaseIndex = Number(new URL(redisUrl).pathname.replace('/', '')) || 0;
if (databaseIndex === 0) {
  throw new Error('Refusing to flush Redis database index 0, which a dev server may share.');
}

const { Redis } = await import('ioredis');
const client = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
try {
  await client.flushdb();
} finally {
  await client.quit();
}
