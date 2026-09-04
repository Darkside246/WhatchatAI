# AURA Engineering Checkpoint

Durable, repo-committed continuation state for the AURA master directive.
This is not conversational memory — a future session (or a future Claude
Code session with no access to this conversation) should be able to read
this file, `AURA_MASTER_CHECKLIST.md`, and `AURA_FINAL_ENGINEERING_REPORT.md`
and resume without reconstructing history from chat scrollback.

**Continuation protocol**: READ THIS FILE → READ `AURA_MASTER_CHECKLIST.md`
→ READ `AURA_FINAL_ENGINEERING_REPORT.md` → VERIFY REPOSITORY STATE
(`git log`, `git status`, `npx tsc --noEmit`) → IDENTIFY THE NEXT OPEN
ITEM FROM §"NEXT ACTION" BELOW → CONTINUE. Do not ask the user to repeat
information already recorded here.

---

## Current master-directive position

**135-section directive: functionally closed.** Every section either
COMPLETE, PARTIALLY COMPLETE with an explicitly named remaining item, or
explicitly REQUIRES USER ACTION / DEFERRED / NO RECORD. Full section-by-
section table: `docs/AURA_FINAL_ENGINEERING_REPORT.md` §1.

- **Completed sections**: ~118 of 133 accounted-for numbered sections
  (see report §1 for the full table and accounting; 2 section numbers, 95
  and 135, have no record anywhere in the directive's history — flagged,
  not guessed at).
- **Current section**: none open — the directive itself is at a real
  stopping point pending only the external/business items below.
- **Next section**: whatever the user directs next. No numbered section
  remains that this engineering process can advance without new
  information (a credential, a file, or a policy decision).

## Files changed this checkpoint's session (BullMQ/Redis reliability + wrap-up)

- `src/queue/workers/incomingMessagesWorker.ts` — gated 14 sweep-scheduler
  registrations behind `NODE_ENV !== 'test'`.
- `test/globalSetup.ts` — automated once-per-suite Redis flush (replaces
  manual `redis-cli flushall`).
- `test/setupFile.ts` (new) — per-test-file Redis flush (registered in
  `vitest.config.ts`'s `setupFiles`).
- `test/waitForWorkerEvent.ts` (new) — shared, leak-free job-completion
  wait helper, replacing 7 buggy inline copies across 3 files.
- `test/bullmqControl.test.ts` (new) — minimal control BullMQ test.
- `test/aiReplyWorkerIntegration.test.ts`, `test/incomingMessagesQueue.test.ts`,
  `test/operatorSelfChatRouting.test.ts` — `beforeAll` `waitUntilReady()`
  guards, wired to the shared helper, orphaned-promise-sequencing fix.
- `vitest.config.ts` — added `setupFiles`.
- `docs/BULLMQ_REDIS_TEST_RELIABILITY_CHECKPOINT.md` (new) — the
  reliability-investigation-specific checkpoint (FACT/HYPOTHESIS/ACTION/
  VERIFICATION structure).
- `docs/AURA_FINAL_ENGINEERING_REPORT.md` (new) — Sections 130-134.
- `docs/AURA_ENGINEERING_CHECKPOINT.md` (this file, new).
- `AURA_MASTER_CHECKLIST.md` — Section 130-134 marked complete, USER
  ACTION REQUIRED block added (see that file directly for the live
  section-checklist markers).

## Database migrations

No new migrations this checkpoint's session. Most recent: `980_ai_token_topup.sql`
(AI token top-up purchases table + notification-type extension). Full
migration history is the source of truth — see `src/db/migrations/`, not
a count reproduced here (it would drift).

## Tests

- Full backend `npx tsc --noEmit`: clean as of commit `e6ea5dc`.
- `test/bullmqControl.test.ts`: passes consistently in isolation (control
  baseline for BullMQ/Redis infra health).
- `test/aiReplyWorkerIntegration.test.ts`: **KNOWN_FLAKY** — see below.
- Every other test file in the suite: green as of the last full regression
  run referenced in `AURA_MASTER_CHECKLIST.md`'s Section 123-129 entry;
  not re-run in full as part of this specific checkpoint (the reliability
  work targeted the 3 files named above specifically, per the governing
  engineering directive's own scope).

## Known flaky tests

`test/aiReplyWorkerIntegration.test.ts` — 4 confirmed, fixed root causes
(event-listener leak, orphaned-promise crash, production sweep jobs firing
during tests, cross-file Redis leakage — all documented with before/after
evidence in `docs/BULLMQ_REDIS_TEST_RELIABILITY_CHECKPOINT.md`). Residual
flakiness remains, classified `UNRESOLVED / ENVIRONMENT OR COLD-START
HYPOTHESIS` — a binary pass-in-~5s-or-hit-the-10s-timeout pattern
consistent with (not yet proven to be) a BullMQ worker cold-start race.
**Do not** re-classify this as fixed without new evidence, and do not
re-classify it as a confirmed application defect either — both would
contradict the directive's own explicit instruction on this point.

Also documented in project memory: `project_flaky_circuit_breaker_test.md`
(15+ prior instances of the broader "flaky under full-suite load" pattern,
predating this checkpoint's specific investigation).

## Known blockers (external, not engineering)

1. **Google OAuth**: `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` absent from
   `.env` (present, empty, in `.env.example`). Blocks Google Meet booking
   from ever being "operational," though the code path degrades honestly.
2. **Zoom OAuth**: `ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET`, same situation.
3. **whatsmeow-main.zip**: not present anywhere in the repository. Blocks
   only the specific Baileys-alternative review task; nothing else
   depends on it.
4. **WiPay real API/webhook docs**: site is JS-rendered, could not be
   fetched. `wipayProvider.ts` deliberately stays inert
   (`WIPAY_INTEGRATION_NOT_YET_IMPLEMENTED`) rather than guessing a
   signature scheme for real money.

## External dependencies

Gemini 3.5 Flash (primary AI provider, real pricing researched and
documented in `aiTokenTopupService.ts`), Goose (global failover
infrastructure, `GOOSE_SERVICE_URL`), Baileys (WhatsApp transport),
BiMPay (manual bank-transfer payment provider), PayPal (real automated
payment provider), Postgres, Redis (single shared server process in this
dev environment — see the BullMQ checkpoint for the persistence
implication), WSL2 (this session's dev/test execution environment).

## Unresolved issues

- `aiReplyWorkerIntegration.test.ts` residual flakiness (above).
- Sections 95 and 135 have no record anywhere — needs the user to restate
  them or confirm they were folded into an adjacent section.
- Retention TTL for `customer_memory`/`conversation_states` — undefined,
  a real policy decision.
- Observability investment — a real cost/tooling decision, deliberately
  not defaulted into.

## Architectural decisions made this checkpoint's session

- Redis test isolation happens at **two** distinct scopes now, not one:
  `globalSetup.ts` (once per whole `vitest run` invocation) and
  `setupFile.ts` (once per test file, before that file's own top-level
  imports run). Both are necessary — see the reliability checkpoint doc
  for why one alone is insufficient given `fileParallelism:false` +
  per-file module isolation.
- Production background sweep schedulers (14 of them, in
  `incomingMessagesWorker.ts`) are now gated behind `NODE_ENV !== 'test'`.
  This is a real, intentional behavior difference between test and
  every other environment — confirmed safe (`NODE_ENV` is `'test'` only
  under vitest, never in dev or prod).

## Important discoveries this checkpoint's session

- A real BullMQ `Worker` starts consuming jobs the instant it is
  constructed (`new Worker(...)`), before any `beforeAll` hook can run —
  this is why Redis isolation had to move into `setupFiles`, not stay in
  a `beforeAll`.
- `upsertJobScheduler({every: N})` fires its first occurrence immediately
  on registration (module-import time), not after the first interval —
  this is why the ai-handoff-sweep (and its 13 siblings) were interfering
  with tests despite Redis being freshly flushed.
- Sections 95 and 135 of the original 135-section directive have no
  surviving record anywhere in this repository or in durable memory.

## Last commit

`0571167` — docs: close out the 135-section AURA master directive
(Sections 130-134). Includes this file, the final report, and the master
checklist update. Preceded by `e6ea5dc` (the BullMQ/Redis reliability
fixes this checkpoint documents).

## Next action

1. Wait for the user to resolve one of the REQUIRES USER ACTION items
   (§"Known blockers" above) — no further numbered-section engineering
   work is currently unblocked without new information.
2. If the user provides new direction unrelated to the above (a new
   feature, a new vertical, a bug report), treat it as new work outside
   the 135-section directive's now-closed scope, using this checkpoint
   and the final report as background context, not as a task list to
   keep grinding through.
