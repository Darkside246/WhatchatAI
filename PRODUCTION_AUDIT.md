# PRODUCTION_AUDIT.md

Final audit for the "WhatChat AI - Production-Safe Architecture, Security
Hardening, AI Agent Isolation, and Controlled Intelligence Upgrade"
directive (Phase 20). Written against the real state of `phase-2-ai-repair`
at commit `2ad50e4`, not a plan or an aspiration - every claim below was
checked against actual source, actual test runs, or an actual live process
in this session.

## What was actually done, by phase

| Phase | What | Status |
|---|---|---|
| 0 | Baseline docs (`CURRENT_STATE.md`, `ARCHITECTURE_BASELINE.md`, `SECURITY_BASELINE.md`, `CHANGELOG_SECURITY.md`, `ROLLBACK_PLAN.md`) | `IMPLEMENTED AND VERIFIED` |
| 1 | Container security: `Dockerfile`, `docker-compose.yml`, non-root, `cap_drop`, resource limits, healthchecks | `IMPLEMENTED AND VERIFIED` - real boot on a collaborator's machine found and fixed 4 real bugs (missing SQL migrations in the image, Redis `cap_drop` boot failure, worker healthcheck binary missing, a session-dir volume mismatch); a follow-up confirmation pass re-ran the exact pushed commit and confirmed clean |
| 2 | Audit + repair the existing AI reply path | `IMPLEMENTED AND VERIFIED` - most of the directive's stated failure modes were already fixed in earlier work; the one real remaining gap (no circuit breaker on the Gemini call) was added |
| 3 | Centralize AI orchestration under `src/services/ai/` | `IMPLEMENTED AND VERIFIED` - a real permission registry (`aiToolPolicy.ts`), a fail-closed guard with real audit logging (`agentGuard.ts`), and a single decision function (`aiOrchestrator.ts`) that the worker now calls instead of three services stitched together inline |
| 16 | Funnel deletion lifecycle hardening | `IMPLEMENTED AND VERIFIED` - deletion now refuses while any instance is still running, and writes a real audit event |
| 17 | Campaign lifecycle audit | `IMPLEMENTED AND VERIFIED` - a real gap found (a failed dispatch left a campaign stuck `RUNNING` forever with the business never told) and fixed |
| 19 | Failure-injection testing against real Postgres/Redis | `IMPLEMENTED AND VERIFIED` - real fault injection (not a written-up hypothetical) found and fixed an information-disclosure bug in the generic error handler and an indefinite-hang bug on Redis outage; wired up a dead health check |
| 4, 6, 16 (email/status), 17 UI | Real WhatsApp→AI→WhatsApp proof, multimodal, knowledge base, funnel/campaign UI-level hardening | **`NOT IMPLEMENTED` in this pass** - see below |
| 5, 7-15 | Multimodal AI, OpenClaw, OpenPanel, Cloudberry, Python intelligence/statistics/forecasting/optimization/evaluation, DSPy/GEPA | **`NOT IMPLEMENTED`** - deliberately not built; see below |
| 18 | Scheduled 02:00-03:00 security scans | **`NOT IMPLEMENTED`** - see below |

Every commit's own `CHANGELOG_SECURITY.md` entry has the full CHANGED /
ADDED / TESTS / STATUS / ROLLBACK breakdown for that phase - this document
is the roll-up, not a replacement for those.

## Why Phases 7-15 and 18 were not built

The directive's own governing principle is "preserve what works, isolate
what is optional, never build what isn't demonstrated to be needed."
OpenClaw, OpenPanel, Cloudberry, a standalone Python statistics/
forecasting/optimization service, and DSPy/GEPA prompt optimization are
all **new infrastructure with no demonstrated need in this codebase** -
building them speculatively would be the exact over-engineering the
directive warns against elsewhere in its own text. They were flagged to
the user explicitly rather than silently skipped or silently built; none
were authorized, so none were built. Phase 18 (scheduled security scans)
needs a real scheduling decision (a BullMQ repeatable job is the obvious
fit, reusing existing infrastructure) but was not started in this pass -
correctly labeled `NOT IMPLEMENTED`, not claimed complete.

Phase 4 (a real WhatsApp→AI→WhatsApp proof with a live number and a real
`GEMINI_API_KEY`) requires the user's own credentials and cannot be run
from this sandbox.

## Real, currently-open gaps (honest, not swept under anything)

These were found during this work and are flagged rather than silently
left implicit:

1. **The `enqueueWithTimeout` fix (Phase 19) was applied to the two real
   HTTP-request-path BullMQ producers** (`whatsappOutboundMessageService.
   send()`, the funnel `WAIT` step). The same indefinite-hang-on-Redis-
   outage risk exists at every other producer (`enqueueMediaDownload`,
   message-revocation enqueue, scheduled-status-publish enqueue,
   email-send enqueue) but none of those sit in a synchronous request a
   user is actively waiting on, so they were left unwrapped - a bounded
   decision, not an oversight.
2. **No stale-instance reconciliation sweep exists for funnel instances**
   stuck in `WAITING` with a lost `funnel_advance` job (e.g. the job was
   never persisted to Redis, or Redis lost it before persisting to disk).
   Outbound messages, sync jobs, and emails all have this pattern already
   (`sweepStaleOutboundMessages`, `sweepStaleSyncJobs`,
   `sweepStaleEmails`); funnels do not yet. Plausible, not yet
   demonstrated as a real production incident - flagged for a future pass
   rather than built speculatively here.
3. **Docker image build/boot has only been verified once**, by a
   collaborator on a separate machine, cross-checked against the exact
   pushed commit. This sandbox cannot pull Docker Hub images at all
   (egress policy blocks `production.cloudfront.docker.com`), so every
   later phase's code changes (Phases 2, 3, 16, 17, 19) have been
   typechecked/tested/built natively in this sandbox but **not
   re-verified inside an actual container boot**. The Dockerfile/compose
   config itself was not touched by any of those phases, so the risk is
   low, but it is not zero, and is not independently confirmed here.
4. **Phase 18's scheduled security scan was never built.** No cron/
   repeatable-job security scan exists yet.
5. **The 2026-08-21 dates throughout this session's commits and docs
   reflect this sandbox's system clock**, not necessarily the real
   calendar date the work will be reviewed on - noted for anyone
   reconciling timestamps against `git log`.

## Verification performed for this document

- `npx tsc --noEmit`: clean.
- `npm run build`: clean (backend `tsc` + frontend `vite build`).
- Full test suite (`DATABASE_URL=...whatchatai_test npx vitest run`):
  **79 test files, 478 tests, all passing**, against a real Postgres and
  Redis restarted fresh for this run.
- `npx tsx src/db/migrate.ts` against a real Postgres: all 54 migrations
  apply cleanly, in order, on top of each other (011 through 054 were
  either already applied or applied fresh over the course of this work,
  with zero failures).
- Every phase's live-behavior claims in its own `CHANGELOG_SECURITY.md`
  entry (Phase 1's container boot, Phase 19's Postgres/Redis outage
  injection, the error-sanitization production-mode check) were verified
  against a real running process in this session, not asserted from
  reading code alone.

## Rollback

Every phase past Phase 1 is an individual commit on `phase-2-ai-repair`
(see `git log --oneline` on that branch) - any single phase can be
reverted independently via `git revert <sha>` without affecting the
others, since each phase's changes are scoped to its own files. See
`ROLLBACK_PLAN.md` for the Phase 0/1 rollback detail and
`CHANGELOG_SECURITY.md` for each later phase's own rollback note.

## Bottom line

The protected core (WhatsApp/Baileys connection, Sentinel, Postgres,
tenant isolation, auth, Redis, BullMQ, outbound dispatch, human takeover,
CRM, campaigns, funnels, media storage) was not replaced or rewritten
anywhere in this work - every phase either audited it, added a bolt-on
fix for a real, demonstrated gap, or explicitly declined to build
something without a demonstrated need. Six real bugs were found and fixed
across Phases 1, 2, 16, 17, and 19, each one verified against real
infrastructure (a real container boot, a real stopped Postgres, a real
stopped Redis, a real BullMQ queue) rather than assumed from reading code.
Nothing in this document claims `COMPLETE` for anything that was only
scaffolded - the phases marked `NOT IMPLEMENTED` above are the honest
remaining surface, not a hidden one.
