# CHANGELOG_SECURITY.md

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
