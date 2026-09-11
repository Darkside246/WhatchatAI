# AURA / WhatchatAI — working notes for Claude

## Response formatting

Adapted from the `i-have-adhd` skill (https://github.com/ayghri/i-have-adhd,
MIT). It is kept here rather than installed as a plugin because this project
is worked on through Claude Code on the web, where there is no local CLI to
install into. These rules apply to every session on this repository.

1. **Lead with the next action.** The first line is something the reader can
   do. Not context. Not a plan. The action.
2. **Number multi-step tasks.** If the work takes more than one step, write a
   numbered list. Each step is one bounded action.
3. **End with one concrete next action.** If anything is left open, name ONE
   thing the reader can do in under two minutes.
4. **Suppress tangents.** If a second issue exists, finish the first, then
   offer the second as a separate question.
5. **Restate state every turn.** The reader cannot hold "we are on step 3 of
   5" between messages. Restate it.
6. **Give specific time estimates.** Vague estimates fail. Ballpark in
   concrete units.
7. **Make completed work visible.** Show what now works, in concrete terms.
   Do not bury wins in a recap.
8. **Matter-of-fact tone for errors.** Never "Uh oh", "Oh no", or "There
   seems to be a problem". State cause and fix.
9. **Cap lists to 5 items.** For long lists in the final response, group
   related items and rank the most relevant first.
10. **No preamble, no recap, no closing pleasantries.** Start with the
    answer. End when the answer is done.

### Where these rules stop

They govern LENGTH and SHAPE, never accuracy. They do not license:

- dropping a caveat that changes what the reader should do,
- reporting work as finished before its tests actually pass,
- hiding a failure, a skipped step, or an assumption to keep a reply short.

If a rule and honesty conflict, honesty wins and the reply gets longer.

## Project specifics

- **Never disturb the Baileys/WhatsApp connection.** Session state lives in
  the `whatsapp-session` Docker volume, mounted only on `app-server`. Changes
  must not force a QR re-scan.
- **`MASTER_ENCRYPTION_KEY` must never change.** Every encrypted row derives
  from it via per-tenant HKDF; a new key makes existing data unreadable.
- **Route AI calls through `AiGateway`,** never a provider SDK directly.
  `npm run check:ai-call-sites` enforces this.
- **Every mutating `/api/workspace` route needs a real permission guard.**
  `test/routeAuthorization.test.ts` enforces this.
- **Run the full suite before saying work is done.** Targeted runs have twice
  missed regressions in unrelated files during this project.

## Commands

```
npm run typecheck            # backend + web
npm run build                # production build
npm run check:ai-call-sites  # AI call-site guard
npx vitest run               # full suite (~20 min, needs Postgres + Redis)
```
