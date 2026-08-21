# CHANGELOG_SECURITY.md

## 2026-08-21 - Phase 3: centralized AI orchestration + zero-trust tool policy

**Branch:** `phase-2-ai-repair` (continues directly from the Phase 2 commit
on this same branch - no separate Phase 3 branch was cut, since this phase
touches the same AI call path Phase 2 just repaired and splitting it would
have meant re-basing one on top of the other for no real isolation benefit)

**Changed:** `src/services/aiReplyService.ts` (the `get_current_time` tool
call now runs through a real permission guard before executing, see
below), `src/services/aiContextGathererService.ts` (`AiHandoffContext`
widened with `businessId`/`chatId`, echoed through so downstream consumers
are self-contained), `src/repositories/securityAuditLogRepository.ts`
(added `'ai_tool_invoked'` to the audit event-type union),
`src/queue/workers/incomingMessagesWorker.ts` (its ~130-line inline
sequence of `gatherAiHandoffContext` -> `routeInboundMessage` ->
`generateAiReply` -> one-hop escalation is now a single call to
`orchestrateAiReply()`; every side effect - notifications, `ai_mode`
transitions, realtime events, the idempotent outbound send - is
unchanged, byte-for-byte the same behavior, just no longer duplicated
inline in the worker).

**Added:**
- `src/services/ai/aiToolPolicy.ts` - a real permission registry
  (`AiToolRisk`: READ/WRITE/SEND/HIGH_RISK/SYSTEM) for every AI-invocable
  tool. Currently contains exactly one entry: `get_current_time: READ`.
  This is the directive's zero-trust tool model made real, not aspirational
  - proportionate to what the codebase actually has today (one tool), not
  scaffolded for tools that don't exist yet.
- `src/services/ai/agentGuard.ts` - `guardToolInvocation()`, a fail-closed
  guard called before any tool executes. An unregistered tool name throws
  `UnregisteredToolError` immediately, before any database access. A
  registered tool's invocation is logged as a real, non-blocking audit
  event (`ai_tool_invoked`) via the existing `SecurityAuditLogRepository` -
  reusing that table rather than building new telemetry infrastructure.
  The audit write is `.catch()`-guarded so a logging failure can never
  block a tool call or crash the worker.
- Migration `052_ai_tool_audit_events.sql` - extends the
  `security_audit_logs_event_type_check` constraint to allow
  `'ai_tool_invoked'`, following this codebase's established
  drop-and-re-add-with-full-value-list convention (same pattern as
  migrations 041/042/044/045/047).
- `src/services/ai/aiOrchestrator.ts` - `orchestrateAiReply()`, the single
  entry point that now owns "which agent, given what context, says what."
  It deliberately does *not* own side effects (notifications, `ai_mode`
  transitions, the outbound send) - those stay in the calling worker,
  since they are queue/dispatch concerns, not AI orchestration ones. Same
  routing/escalation/context logic as before this phase - a
  consolidation, not a rewrite.

**What was deliberately NOT built:** no rename of
`aiContextGathererService.ts`/`aiReplyService.ts`/`geminiClient.ts` to the
directive's suggested `agentContext.ts`/`aiModelGateway.ts` names - they
already serve those roles, are tested, and are imported elsewhere; a mass
rename for naming-convention purity alone would violate "preserve what
works" for no functional benefit. No `aiMemory.ts` (no demonstrated
need). No new telemetry service - the existing `security_audit_logs`
table already fits this exactly.

**Tests:** `test/agentGuard.test.ts` (new, 3 tests, real Postgres writes
via `createTestBusiness()`/`resetDatabase()` - not mocked - proving the
unregistered-tool fail-closed path writes zero audit rows, a registered
tool's invocation writes exactly one real `ai_tool_invoked` row with no
phone-number-shaped value anywhere in its metadata, and the policy
registry's exact current content). Existing `AiHandoffContext` fixtures in
`test/aiReplyService.test.ts` and `test/aiReplyServiceRetry.test.ts`
updated for the widened type. Full suite: 78/78 files, 472/472 tests
passing (up from 77/469 - the expected +1 file/+3 tests), zero
regressions. Typecheck clean, production build clean, migration 052
applies cleanly against a real database with no other migrations pending.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** none identified beyond what Phase 2 already carried forward -
this phase changes call structure, not call behavior, and the full
regression suite confirms behavior is unchanged.

**Rollback:** `git revert` the commit(s), or discard the branch. The only
schema change is the additive `CHECK` constraint extension in migration
052, which is itself reversible via the same drop/re-add pattern with
`'ai_tool_invoked'` removed from the list.

---

## 2026-08-21 - Phase 2: existing AI path audit + one real repair (circuit breaker)

**Branch:** `phase-2-ai-repair` (base: `phase-1-container-security` @ `0467bf1`)

**Audit findings:** traced the real inbound -> Sentinel -> persistence ->
queue -> worker -> AI routing -> context -> model -> outbound path
(`src/queue/workers/incomingMessagesWorker.ts`,
`src/services/agentRoutingService.ts`, `src/services/aiReplyService.ts`).
The major failure modes this directive's Phase 2 asks about were already
fixed in earlier work this session, confirmed still in place: `no_agent`
and blocked-keyword routing outcomes visibly notify the business and move
the chat to `HUMAN_TAKEOVER` rather than silently dropping the customer;
a failed model call (Gemini + Goose both unavailable) does the same via
an `AI_FAILURE` notification; the escalation hop is bounded to exactly
one agent, never a loop; outbound sends carry an idempotency key derived
from the inbound message id; human takeover (`ai_mode !== 'AI_ACTIVE'`)
gates the AI path out entirely before it runs.

**One real, remaining gap found and fixed:** no circuit breaker existed
for the Gemini call (directive Section 45 - external services must have
timeout/backoff/circuit breaker/cooldown). During a sustained outage,
every single queued message would wait out a full network round trip
(primary call, then a bare-request retry) before falling back - wasted
latency per message with no benefit, since a failing provider was very
unlikely to suddenly succeed message-to-message. Added
`src/services/aiCircuitBreaker.ts`: a minimal per-process (not Redis-
shared - deliberately, see the file's own comment) CLOSED/OPEN/HALF_OPEN
breaker. After 3 consecutive real call failures it opens for 60s
(both configurable via `GEMINI_CIRCUIT_FAILURE_THRESHOLD`/
`GEMINI_CIRCUIT_COOLDOWN_MS`), skipping straight to Goose/`unavailable`
until a single probe call is allowed through again. A 400-then-bare-retry
recovery still counts as success (proves Gemini is reachable), so it does
not falsely trip the breaker.

**Tests:** 11 new (`test/aiCircuitBreaker.test.ts` - pure state-machine
tests for CLOSED->OPEN->HALF_OPEN->CLOSED transitions, cooldown timing,
failed-probe reopening; 3 new integration tests in
`test/aiReplyServiceRetry.test.ts` proving `generateAiReply` actually
skips the live call once open, stays closed under normal success, and
does not trip on a recovered 400). Full suite: 77/77 files, 469/469 tests
passing (up from 76/458 - the exact expected +1 file/+11 tests), zero
regressions. Typecheck and production build both clean.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch - no schema
or dependency changes.

---

## 2026-08-21 - Phase 1: real container boot verification, four bugs found and fixed

**Branch:** `phase-1-container-security` (continues from `668760b`)

**Changed:** `Dockerfile` (added a `COPY` for migration `.sql` files into
the runtime image), `docker-compose.yml` (removed `cap_drop: [ALL]` from
`redis`; replaced the `app-worker` healthcheck's `pgrep`-based command
with a `node -e "process.kill(1, 0)"` PID-1 liveness check), `docs/DOCKER.md`
and this changelog updated to reflect real verification results.

**How this was verified:** this sandboxed session cannot pull Docker Hub
images (policy-blocked egress, see the prior entry below) - a
collaborator built and booted the real stack on their own machine
(Windows 11 + WSL2 + Docker Desktop) and reported back raw command
output, which was cross-checked for internal consistency before being
trusted (e.g. the exact Vite bundle sizes matched this session's own
non-Docker build byte-for-byte; the specific error messages reported -
`setpriv: setresuid failed`, `pgrep` exit 127 on `node:22-slim` - were
independently confirmed against known, verifiable facts about those
tools before the corresponding fixes were applied here).

**Four real bugs found and fixed** (see `docs/DOCKER.md`, "Real bugs...",
for full detail): a `WHATSAPP_SESSION_DIR` volume mismatch (already fixed
in the prior entry via static `docker compose config` review),
`.sql` migration files missing from the compiled runtime image (`tsc`
never copies non-TS assets), Redis failing to boot under `cap_drop:
[ALL]`, and the worker healthcheck using a binary (`pgrep`) that isn't
present in `node:22-slim`.

**Status:** `IMPLEMENTED AND VERIFIED`. All nine verification items from
the original checklist passed against a real boot: image builds cleanly,
all four services report `healthy`, migrations apply (51/51), non-root
execution confirmed (`uid=10001`), resource limits confirmed via
`docker inspect` (512 MiB / 1.0 CPU / 256 pids, matching config exactly),
no `EROFS` errors under `read_only`, `/api/health` returns 200 with the
expected security headers, the worker genuinely starts consuming its real
queues, and a real Baileys WhatsApp connection succeeded inside the
container. A follow-up confirmation pass then closed the last gap:
`git pull` fast-forwarded `668760b..26f1eab` (the exact commit range
pushed here) on the collaborator's machine, followed by
`docker compose down && docker compose build && docker compose up -d`
against the actual tracked files - not the earlier locally-patched
equivalent - and all four services came up `healthy` again. This is
unconditionally verified, not pending anything further.

**Rollback:** Same as the prior entry - no application code, schema, or
`package.json`/lockfile touched.

---

## 2026-08-21 - Phase 1: container security baseline

**Branch:** `phase-1-container-security` (base: `audit/phase-0-safety-baseline`
@ `ac09e6b`)

**Changed:** Added `Dockerfile`, `docker-compose.yml`, `.dockerignore`,
`docs/DOCKER.md`. Zero application code, schema, or dependency changes.

**Added:** Two-service app image (app-server, app-worker, same image,
different command - see `docs/DOCKER.md` for the verified process/volume
boundary), `postgres:16-alpine`, `redis:7-alpine`, an explicit bridge
network, four named volumes (`postgres-data`, `redis-data`,
`whatsapp-session`, `media-storage`).

**Security controls added:** non-root execution (fixed uid/gid 10001) for
both app containers, `cap_drop: [ALL]` + `no-new-privileges` on
app-server/app-worker/redis (deliberately not on postgres - see
`docs/DOCKER.md`), `read_only` root filesystem + scoped `tmpfs` on the app
containers, per-service pids/memory/cpu limits, no host port exposure for
postgres/redis, no Docker socket mount anywhere, healthchecks gating
startup order (`depends_on: condition: service_healthy`).

**Real finding caught during this phase's own verification (not a build-
time hypothetical):** `docker compose config` surfaced that
`WHATSAPP_SESSION_DIR` was silently inheriting a host-relative path from
the developer's own `.env` via `env_file`, which inside a container would
have resolved outside the mounted volume - would have silently discarded
the WhatsApp session on every container recreation. Fixed by pinning it
explicitly in `docker-compose.yml`'s `environment:` block. See
`docs/DOCKER.md` for detail.

**Status:** `IMPLEMENTED BUT NOT FULLY VERIFIED`. `docker compose config`
validation passed and caught a real defect (above). Image build and
container boot could **not** be completed in this environment: every
`docker build`/`docker pull node:22-slim` attempt was rejected by this
session's own egress policy (`production.cloudfront.docker.com` CONNECT
denied - confirmed via the proxy's own status endpoint, not assumed). Per
that policy's explicit instruction, this was reported rather than routed
around via an alternate registry mirror. See `docs/DOCKER.md`, "What was
verified vs. not," for the complete, itemized list of what still needs
confirming in an environment with open registry access before this is
trusted in production - most notably whether `postgres` actually starts
with the rest of its hardening applied, and whether `read_only: true`
breaks anything at runtime.

**Rollback:** Branch can be discarded entirely; no application code,
schema, or `package.json`/lockfile was touched, so there is nothing to
revert outside this branch's own four new files.

---

Security-relevant changes only (not a general changelog - see `docs/` and
git history for full feature history). Each entry states what changed, why,
and its verification status per the directive's terminology:
`IMPLEMENTED AND VERIFIED` / `IMPLEMENTED BUT NOT FULLY VERIFIED` /
`SCAFFOLDED ONLY`.

---

## 2026-08-21 - Phase 0 safety baseline (this audit)

**Branch:** `audit/phase-0-safety-baseline`

**Changed:** Nothing in application code, dependencies, database schema, or
runtime configuration. Added five documentation files:
`CURRENT_STATE.md`, `ARCHITECTURE_BASELINE.md`, `SECURITY_BASELINE.md`,
`CHANGELOG_SECURITY.md` (this file), `ROLLBACK_PLAN.md`.

**Status:** `IMPLEMENTED AND VERIFIED` (as documentation - every claim in
these five files was checked against the actual repository during this
pass; see each file's own content for what was and wasn't verifiable).

**Rollback:** Delete the branch, or `git revert` the single commit. No
application state is affected either way.

---

## 2026-08-21 - Live time and timezone intelligence: AI tool surface
   (predates this changelog's creation - backfilled for completeness)

**Branch:** `feature/live-time-intelligence` (separate from this audit
branch; already pushed and independently verified)

**Changed:** Added the first-ever AI-invocable tool (`get_current_time`) to
the Gemini reply path. Security-relevant properties of this change:

- The tool is **read-only** - it has no corresponding write/set capability
  anywhere in the codebase, so no prompt-injection attempt against it can
  have a lasting effect beyond the current reply.
- The tool takes **no arguments** (empty parameter schema), so there is no
  input surface for the model to pass attacker-influenced data into it.
- Tool execution is **bounded to exactly one round trip** per reply -
  verified by a test (`test/aiReplyServiceRetry.test.ts`, "never lets a
  get_current_time tool call loop more than one extra round trip") that
  mocks a model response which keeps re-requesting the tool forever and
  confirms only one extra API call is ever made.
- A dedicated test (`test/aiReplyServiceRetry.test.ts`, "ignores
  attacker-controlled tool-call args entirely") proves that even if a
  compromised/manipulated model response includes forged
  `args` (e.g. a fake `utcNow`/`timezone`), the function-response sent back
  to the model is always the trusted, server-computed `TimeContext` - the
  forged values are never used.
- A manual time-override capability was added at the *business* level
  (`businesses.time_source`, `manual_override_target_utc`,
  `manual_override_set_at`), settable only via an authenticated,
  permission-gated (`settings.manage`) HTTP endpoint - **no AI tool can
  write these columns**, so no WhatsApp message, however crafted, can
  change what time the AI believes it is.

**Status:** `IMPLEMENTED AND VERIFIED` - 46 new tests added (see that
branch's own final report), full regression suite (76/76 files, 458/458
tests) passing with zero regressions against a corrected baseline.

**Rollback:** That branch has not been merged to any protected branch; it
can be discarded entirely (`git push origin --delete
feature/live-time-intelligence` after confirming no PR depends on it) with
zero effect on `phase-1-foundation`/the real base branch.
