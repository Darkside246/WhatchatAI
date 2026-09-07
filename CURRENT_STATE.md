# CURRENT_STATE.md

Phase 0 safety-baseline snapshot. Everything below was directly observed in
this repository/environment on the date noted, not inferred from README
files, comments, or prior documentation. Where something could not be
verified, it is marked `UNKNOWN` rather than assumed.

Captured: 2026-09-07 target-branch security implementation checkpoint.

## 1. Git state

- Repository: `Darkside246/WhatchatAI` (origin, `https://github.com/Darkside246/WhatchatAI`)
- Default branch remains `main`; this work is on `fix-human-message-attribution-target` and does not modify `main`.
- Current base HEAD: `e7f8c26` on branch `fix-human-message-attribution-target`; this worktree contains preserved human-message attribution edits plus the security changes listed below.
- This checkpoint is intentionally uncommitted; no reset or revert was performed.

## 2. Runtime versions

- Node: `v22.22.2`
- npm: `10.9.7`
- No `.nvmrc` or `engines.node` pin beyond `"node": ">=20"` in `package.json`
  (no upper bound)
- TypeScript: `latest` in devDependencies (see §3 - no explicit pin)

## 3. Dependency pinning (real finding)

`package.json` uses the literal string `"latest"` as the version specifier
for a number of dependencies, including production-critical ones:

- Production: `@google/genai`, `@whiskeysockets/baileys`, `concurrently`,
  `dotenv`, `express`, `pino`, `qrcode`, `zod`
- Dev: `@types/express`, `@types/node`, `@types/qrcode`, `tsx`, `typescript`

This means `package.json` itself places no ceiling on these packages: a
fresh `npm install` with a deleted/regenerated lockfile, or an explicit
`npm update`, can pull in a new major version - including of the WhatsApp
transport (`@whiskeysockets/baileys`) and the AI SDK (`@google/genai`) -
with no review gate. The **lockfile** (`package-lock.json`, `lockfileVersion
3`) does currently pin concrete resolved versions, so this is not an
active problem today, only a latent one. Resolved versions at audit time:

| Package | Resolved version |
|---|---|
| `@whiskeysockets/baileys` | `7.0.0-rc14` (pre-release, not a stable tag) |
| `@google/genai` | `2.17.1` |
| `express` | `5.2.1` |
| `zod` | `4.4.3` |
| `pino` | `10.3.1` |
| `qrcode` | `1.5.4` |
| `dotenv` | `17.4.2` |
| `concurrently` | `10.0.5` |

`bullmq` and `ioredis` are pinned with caret ranges (`^6.1.1`, `^6.0.0`) in
`package.json` itself, not `latest`.

## 4. Dependency vulnerability scan

`npm audit` (run against the current lockfile): **0 vulnerabilities** at
every severity (info/low/moderate/high/critical). This is a point-in-time
result, not a recurring scan (see SECURITY_BASELINE.md for the gap).

## 5. Database migration state

39 migrations exist under `src/db/migrations/`, numbered `001`-`051`
sequentially with no gaps. `npx tsx src/db/migrate.ts` against the test
database reports `[migrate] Already up to date.` - the migration runner
tracks applied migrations and is idempotent on re-run.

## 6. Environment configuration

`.env` exists locally (gitignored - confirmed via `.gitignore` lines 3-4:
`.env` and `.env.*`) and is **not** inspected further by this document
(no secret values are reproduced here). `.env.example` documents the real
configuration surface without values:

- `NODE_ENV`, `PORT`
- `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_SENTINEL_MODEL`, `GEMINI_REPLY_MODEL`
- `WHATSAPP_SESSION_DIR`
- `DATABASE_URL`
- `REDIS_URL` (with an explicit warning in-file about dev/test index
  collisions - see the file for detail)
- `MASTER_ENCRYPTION_KEY` (field-level encryption master key - explicitly
  documented as local, not a cloud KMS)
- `RESEND_API_KEY` (outbound email; per-workspace settings can override)
- `GOOSE_SERVICE_URL` (optional AI failover; the file explicitly warns this
  is NOT a plain Goose install and documents the required HTTP contract)

OpenClaw runtime/relay integration is present on this branch. DSPy, OpenPanel,
Cloudberry, and vector-database integrations remain absent.

## 7. Existing services / containers

- A multi-stage non-root `Dockerfile` and `docker-compose.yml` provide the
  API, worker, Postgres, Redis, and relay deployment topology.
- `.github/` contains repository automation and configuration.
- **No ESLint config** (`.eslintrc*`/`eslint.config*` absent) and no `lint`
  script in `package.json`. There is no automated linting today.
- This sandbox environment has PostgreSQL 16 and Redis installed as host
  services (not containers); both were found **stopped** at the start of
  this session's prior work and were started manually to run tests. This
  reflects the sandbox, not necessarily how the application is deployed in
  production - production deployment configuration is `UNKNOWN` from this
  repository alone (no IaC/deployment manifests present).

## 8. Test / typecheck / build results (baseline commit `e7f8c26c`)

Run with both PostgreSQL and Redis available (see prior session finding:
earlier in this session, a test run attempted with Redis stopped produced
131 spurious failures purely from BullMQ job timeouts - restarting Redis
and rerunning produced a clean pass, proving those were environmental, not
code defects):

- **Tests:** 76/76 files passing, 458/458 tests passing
  (`DATABASE_URL=...whatchatai_test npx vitest run`)
- **Backend typecheck:** clean (`tsc --noEmit`)
- **Frontend typecheck:** clean (`cd src/web && tsc --noEmit`)
- **Production build:** succeeds (`npm run build`) - one pre-existing,
  non-error warning: the frontend's main JS chunk is 686 KB
  (198 KB gzipped), above Vite's 500 KB advisory threshold. Not a
  regression, not addressed by this audit.
- **Lint:** not run - no lint tooling exists in this repository (see §7).

No failures exist at this commit. This is the true, current baseline
against which any future phase's changes must be compared.

## 9. High-level component inventory (existence only - see
   ARCHITECTURE_BASELINE.md for how they connect)

Present in the repository: WhatsApp/Baileys connection service, QR pairing,
two-stage Sentinel (regex heuristic + Gemini classification), BullMQ
queues/workers (incoming messages, outbound dispatch, scheduled statuses,
funnel advance, email send, message revocations, realtime events), a
Postgres-backed multi-tenant schema (businesses/users/business_memberships),
session-cookie authentication with Argon2id password hashing, field-level
AES-256-GCM encryption for message bodies, local encrypted media storage,
CRM (contacts/leads), funnels, campaigns, a notification system, a
WebSocket realtime bridge, a React/Vite frontend, OpenClaw cell/relay
runtime components, and multi-provider AI reply generation with Gemini,
OpenAI, Groq, Cerebras, Mistral, OpenRouter, and optional operator-installed
Goose fallback.

Absent from the repository: DSPy/GEPA, OpenPanel, Apache Cloudberry, any
vector-database extension, and any dedicated analytics outbox. Linting remains
unconfigured.

## Current-branch security delta (2026-09-07)

Implemented: normalized gateway usage persistence for quota accounting; Groq/Cerebras/Mistral developer secret status; deterministic duplicate migration ordering plus a documented 071 history marker; encrypted Redis DEK cache; removal of runtime Goose installation; provider allowlist/consent and PII-free attempt audit; fail-closed semantic Sentinel/leak checks; and required compose Postgres/Redis credentials. Human-message attribution changes already present in this worktree were not touched.

Operational blockers: this environment has no running Redis/Postgres, and the local install cannot resolve the pinned Baileys git dependency, so integration tests and the full typecheck remain blocked. Production still needs an operator-verified Goose binary if that optional fallback is desired.

## Follow-up product-surface decisions included in this pass

- The web composer restores focus after Enter, including after an asynchronous send failure.
- Opening `/chats/:chatId` clears that user's chat-targeted notification rows by `target_type/target_id`, including rows already dismissed from the visible notification list. Rows remain persisted history.
- Contact sync remains backend-owned: Baileys `contacts.upsert`/`contacts.update` are the provenance-bearing source and `whatsapp_contacts.source_type` records the origin. A browser cannot read a phone/SIM address book directly; no speculative native implementation was added. A future native companion would need an explicit, consented import API and provenance records.
- Closing-question behavior now has deterministic conversation-state gating and a final-output guard; generic closing questions are suppressed unless the inbound turn or state indicates a real information gap.
