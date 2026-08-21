# ROLLBACK_PLAN.md

## General procedure for this repository

This repository has **no automated rollback tooling** (no down-migrations,
no deployment system, no container orchestration to roll back). Rollback is
git-based and, for schema changes, forward-only:

1. **Code rollback:** every phase of work happens on its own branch, off a
   known-good commit on `phase-1-foundation` (which tracks the real base
   branch `claude/whatchatai-repo-setup-s921z7`). Reverting a phase means
   simply not merging that branch, or reverting the merge commit if it was
   already merged. The base branch is never modified directly by any phase.
2. **Schema rollback:** `src/db/migrate.ts` has **no down-migration
   support** (confirmed by inspection - no `down`/`rollback` handling
   exists in the migration runner). A migration cannot be automatically
   reversed. Reversing a schema change means either:
   - writing a new, forward-only migration that undoes the effect (e.g. a
     `DROP COLUMN` migration to reverse an `ADD COLUMN`), reviewed with the
     same scrutiny as the original, or
   - restoring the database from a pre-migration backup, which is only
     viable if backups are actually being taken (this repository defines no
     backup mechanism - that is infrastructure outside this codebase,
     status `UNKNOWN`).
   Because of this, every migration added in any phase must be reviewed as
   if it cannot be undone, not merely as a draft.
3. **Dependency rollback:** `package-lock.json` pins exact resolved
   versions. Reverting a dependency change means restoring the previous
   lockfile (`git checkout <prior-commit> -- package-lock.json
   package.json && npm install`), not just editing `package.json`.
4. **Runtime/config rollback:** `.env` is not tracked in git and is not
   touched by any phase in this audit. No phase should write to a
   developer's or operator's live `.env` file directly; new variables
   should be documented in `.env.example` (as this repository's existing
   convention already does) and left for the operator to set.

## This audit's own rollback

Branch: `audit/phase-0-safety-baseline`. Contains exactly five new
documentation files, zero application code changes, zero schema changes,
zero dependency changes. Rollback is trivial:

```
git branch -D audit/phase-0-safety-baseline        # if not yet pushed
# or, if pushed:
git push origin --delete audit/phase-0-safety-baseline
```

Nothing else needs to change - no migration to reverse, no dependency to
restore, no running process affected, because nothing runtime-relevant was
touched.

## Rollback readiness for later phases (forward-looking, not yet applicable)

Every future phase in this directive's plan should, before merging:

- State its own base commit explicitly (see `CHANGELOG_SECURITY.md`'s
  per-entry format).
- List every migration it adds, and whether a reverse migration has been
  written and tested.
- List every new external service dependency and its own failure/rollback
  mode (per the directive's own Section 44 "Failure Isolation" - an
  optional service being rolled back or made unavailable must never affect
  the WhatsApp hot path, by construction, not just by intent).
- Be revertable as a single `git revert`/branch-discard without needing a
  second, hand-written cleanup change - i.e. no phase should leave the
  repository in a state where "undo this phase" requires archaeology.
