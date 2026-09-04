# BullMQ / Redis Test Reliability — Engineering Checkpoint

2026-09-04. Investigation carried out under an explicit engineering directive
requiring project-level fixes before any Windows-host-level change, and
strict separation of confirmed FACT from HYPOTHESIS. This is that checkpoint.

## COMPLETED (what changed)

1. **`test/globalSetup.ts`** — automated the Redis cleanup that was previously
   done by hand (`redis-cli flushall`, itself the wrong primitive). Added
   `flushTestRedis()`, called once before the suite (clears leftovers from a
   prior invocation) and once after via the returned teardown. Uses
   `FLUSHDB` (scoped to the enforced, non-zero test database index), never
   `FLUSHALL` — the test Redis instance shares a single `redis-server`
   process with local dev on index 0, so a global flush would be unsafe.

2. **`test/setupFile.ts`** (new, registered in `vitest.config.ts`'s
   `setupFiles`) — a second, per-test-FILE Redis flush, distinct from
   `globalSetup`'s once-per-suite flush. Root cause it fixes: with
   `fileParallelism:false` and vitest's default per-file module isolation,
   every test file gets its own fresh `new Worker(...)` the moment its
   top-level imports run, and a BullMQ Worker starts consuming immediately
   on construction — before any `beforeAll` can fire. A leftover
   delayed/waiting job from the previous file (that file's own
   `afterAll`'s `worker.close()` only waits for currently-*active* jobs,
   never drains queued/delayed ones) was being picked up by the next file's
   brand-new worker and processed against rows that file's own
   `resetDatabase()` had just wiped. `setupFiles` runs before the file's own
   code, so this flush always lands first.

3. **`src/queue/workers/incomingMessagesWorker.ts`** — gated all 14
   `upsertJobScheduler(...)` registrations (the real, production
   backstop/retention sweeps: call-timeout, sync-job-timeout,
   media-download-timeout, ai-handoff, outbound-message-timeout,
   email-timeout, reminder, autonomous-ops, meeting-completion,
   funnel-instance-timeout, document-processing, security-scan,
   openclaw-security-watcher, account-deletion-purge, trial-expiry,
   writing-twin-retention) behind `if (process.env.NODE_ENV !== 'test')`.
   `NODE_ENV` is set to `'test'` only by vitest itself (confirmed: unset in
   dev, `'production'` in prod — matches `src/server/index.ts`'s own
   existing `NODE_ENV` checks), so this cannot affect a real deployment.
   Root cause it fixes: `upsertJobScheduler({every: N})` fires its first
   occurrence immediately on registration, i.e. on module import — before
   that test file's own `beforeEach`/`resetDatabase()` has run.
   `sweepStaleAiHandoff` in particular queries across *all* AI_ACTIVE chats
   with unanswered messages, no test/business scoping, so it was re-arming
   debounce jobs for leftover chats from whatever ran in the shared
   `whatchatai_test` database just before it.

4. **`test/waitForWorkerEvent.ts`** (new, shared helper) — replaced three
   independent hand-rolled `new Promise((resolve, reject) => {...})`
   constructions (one in `aiReplyWorkerIntegration.test.ts`, one in
   `incomingMessagesQueue.test.ts`, five in `operatorSelfChatRouting.test.ts`)
   that all shared the same real bug: on the timeout path, the
   `'completed'`/`'failed'` listeners were never removed via `.off()` — a
   genuine event-listener leak on every timed-out wait, for the rest of
   that file's run.

5. **`test/aiReplyWorkerIntegration.test.ts`** — fixed a second, more severe
   bug found while extracting the helper above: `persisted` and `debounced`
   waits were constructed in parallel (both timers start immediately) but
   awaited sequentially. If `persisted` rejected/timed out first,
   `debounced`'s still-running timer later fired as a genuine **unhandled
   promise rejection**, which crashed the whole worker process via its own
   global handler — taking every subsequent test in the file down with it.
   Fixed at the root by sequencing the waits (only start waiting for
   `debounced` after `persisted` resolves), not by adding a `.catch()`
   no-op.

6. **`test/aiReplyWorkerIntegration.test.ts`**, **`incomingMessagesQueue.test.ts`**,
   **`operatorSelfChatRouting.test.ts`** — added a `beforeAll` calling
   `waitUntilReady()` on every Worker/Queue the file drives, replacing an
   undeclared "connection setup always finishes in time" assumption with a
   real, observable BullMQ precondition.

7. **`test/bullmqControl.test.ts`** (new) — a minimal control test: bare
   `Queue`/`Worker` pair with nothing else registered against them,
   create → process → complete → close. Used to determine whether the raw
   Redis/BullMQ environment itself is unstable, independent of anything
   Aura's own worker module does.

## VERIFIED (what passed)

- Control test (`test/bullmqControl.test.ts`): passes consistently; its
  `worker.close(); queue.close();` measured **7ms**. This is real evidence
  the underlying Redis/BullMQ environment itself is not slow.
- With the sweep-registration gate applied, `[RealtimeEventsWorker] Re-armed
  AI debounce for N chat(s)...` no longer appears in an isolated run of
  `aiReplyWorkerIntegration.test.ts` — confirms that specific interference
  source is eliminated.
- With `test/setupFile.ts` applied, the specific
  `security_audit_logs_whatsapp_account_id_fkey` violation observed in a
  3-file bundled run (`aiReplyWorkerIntegration.test.ts` +
  `incomingMessagesQueue.test.ts` + `operatorSelfChatRouting.test.ts`) has
  not recurred in subsequent runs.
- `npx tsc --noEmit` clean after every change in this checkpoint.
- All 5 inline listener-leak copies removed; `grep` for
  `new Promise|\.off\(` in `operatorSelfChatRouting.test.ts` returns nothing.

## FAILED / FLAKY (what remains nondeterministic)

`aiReplyWorkerIntegration.test.ts` run alone, fresh Redis flush before each
run, 5 consecutive isolated invocations, recorded in full (not
cherry-picked):

| Run | Test 1 (no agent) | Test 2 (no_agent visible) | Test 3 (no GEMINI key) | Test 4 (budget-exhausted) |
|---|---|---|---|---|
| 1 | PASS (5.7s) | **FAIL** (10.6s) | PASS (0.4s) | **FAIL** (16.0s) |
| 2 | **FAIL** (10.4s) | **FAIL** (10.5s) | PASS (0.3s) | **FAIL** (10.5s) |
| 3 | **FAIL** (10.5s) | **FAIL** (10.4s) | PASS (0.4s) | **FAIL** (15.4s) |
| 4 | PASS (4.8s) | **FAIL** (10.4s) | PASS (0.3s) | **FAIL** (10.4s) |
| 5 | **FAIL** (10.4s) | PASS (10.2s) | PASS (0.4s) | PASS (14.8s) |

**This is still flaky.** Test 3 (no GEMINI key configured, no BullMQ job
wait involved) passed all 5/5 — it never touches the worker-wait path at
all, which is itself evidence the flakiness is specific to the
worker-job-completion wait, not something wrong with the test file broadly.

The 3-file bundle (`aiReplyWorkerIntegration.test.ts` +
`incomingMessagesQueue.test.ts` + `operatorSelfChatRouting.test.ts`) run
together still shows failures post-fix, though the *specific* failure
signatures changed (generic `waitForWorkerEvent` timeouts and `afterAll`
hook timeouts on `.close()`, not the sweep interference or FK violation
that were root-caused and fixed above).

## ROOT CAUSE (confirmed only)

1. Event-listener leak on the timeout path of 3 test files' inline wait
   helpers (fixed).
2. Orphaned parallel-promise construction crashing the worker process via
   an unhandled rejection (fixed).
3. `sweepStaleAiHandoff` (and 13 sibling sweeps) registering and firing
   immediately at module-import time during tests, acting on
   test-database state with no scoping to the currently-running test
   (fixed via `NODE_ENV !== 'test'` gate).
4. Redis not flushed between test *files* (only once for the whole suite),
   so a leftover delayed/waiting job from file N was consumed by file N+1's
   freshly-constructed worker against file N+1's already-reset database
   (fixed via `test/setupFile.ts`).

## HYPOTHESES (not yet confirmed — kept separate from the above)

- The remaining flakiness shows a **binary** pattern per test — either it
  completes in ~4–6s or it hits *exactly* the wait's own timeout boundary
  (~10.4s, matching the 10_000ms `persisted` wait almost to the
  millisecond) — not a smooth distribution of "a bit slower, a bit
  faster." That shape is more consistent with an intermittent
  **worker cold-start race** (the job-fetching loop not yet actively
  polling in the instant after `waitUntilReady()` resolves, on the very
  first job(s) a freshly-constructed worker is asked to process) than with
  generic environmental slowness. Not yet confirmed — would need
  BullMQ-internal instrumentation (e.g. hooking `Worker`'s own internal
  poll/lock-renewal events) to verify directly.
- WSL2 resource contention and Windows Defender scanning remain unranked
  HYPOTHESES per the original directive — **not investigated this
  checkpoint**, since project-level causes were still surfacing real,
  fixable bugs (4 confirmed root causes above) each time this was
  attempted. Per the directive, host-level investigation is authorized
  only once project-level causes are exhausted; that bar has not yet been
  met given the cold-start hypothesis above is still untested.

## NEXT ACTION

Investigate the cold-start hypothesis directly: instrument or research
whether `Worker.waitUntilReady()` truly guarantees the internal
BRPOPLPUSH-style polling loop is already active, or only that the Redis
connection is established. If confirmed, the fix is a real BullMQ-level
synchronization primitive (if one exists) or an explicit first-job probe,
not a timeout increase. This is tracked as follow-up work, not blocking
further Aura sections.

## ENVIRONMENT

- Redis: single `redis-server 0.0.0.0:6379` process in WSL2, serving dev
  (db 0) and test (db 1); `save 3600 1 300 100 60 10000`, `appendonly no`
  (unchanged — persistence is server-wide and dev/test share the process,
  so Step 2 of the original directive's "disable persistence for disposable
  test-only instances" condition is FALSE and was correctly not applied).
- BullMQ: as pinned in `package.json`.
- Postgres: `whatchatai_test` database, real migrations applied via
  `runMigrations`.
- Node: WSL2 Ubuntu userland (`~/aura-worktree`, rsynced from the Windows
  checkout with `--delete`).
- Test config: `vitest.config.ts` — `fileParallelism:false`,
  `testTimeout:15_000`, `REDIS_URL` forced to a non-zero index,
  `globalSetup`+`setupFiles` both now performing Redis isolation at
  different scopes (see COMPLETED above).

## FEATURE STATUS (preserved per directive)

AI Token Top-Up Upsell: **IMPLEMENTED**. Supporting layers (repository,
service, entitlement gate, routes, frontend): **VERIFIED**.
`aiReplyWorkerIntegration.test.ts`: **KNOWN_FLAKY** — real, confirmed
infrastructure bugs found and fixed this checkpoint; residual flakiness
remains under active, separately-tracked investigation. The feature itself
was never reverted or weakened because of this test's instability.
