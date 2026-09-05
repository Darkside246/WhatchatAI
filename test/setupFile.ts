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
/**
 * Follow-up, found while chasing intermittent 15s timeouts in
 * outboundLeakGuard.test.ts/sentinel.test.ts/aiReplyService.test.ts/etc.:
 * this machine's own .env genuinely configures a real GEMINI_API_KEY (for
 * manual/live verification), but the whole test suite's design assumes it
 * is absent - every "AI stage cannot run" test asserts the honest
 * 'unavailable' outcome specifically because no key exists in CI/normal
 * dev. The leak into test workers is real dotenv/config imports inside
 * src/queue/workers/incomingMessagesWorker.ts (and src/server/index.ts,
 * src/services/gooseFallbackSupervisor.ts) - dotenv's default behavior
 * never overrides an already-set process.env var, and vitest's
 * fileParallelism:false reuses one worker process across many files
 * sequentially with a persistent process.env (only the ES module registry
 * is fresh per file, not the process) - so the FIRST file in a worker that
 * happens to import the incoming-messages worker loads the real key once,
 * and it then silently "leaks" into every later file sharing that same
 * worker process, non-deterministically depending on file run order.
 * Forcing it to an explicit empty string (falsy, matching getGeminiClient's
 * own `!apiKey` check) here - before any test file's own top-level imports
 * run - both undoes whatever a prior file in this worker already set and
 * blocks any later dotenv.config() call in THIS file from re-setting it,
 * since dotenv sees the var as "already set" even when empty.
 */
process.env.GEMINI_API_KEY = '';

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
