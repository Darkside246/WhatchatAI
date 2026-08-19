# Phase 2C Completion Report

## PHASE
2C - DATABASE + WHATSAPP DATA FOUNDATION

## STATUS
COMPLETE

| Check | Result |
|---|---|
| DATABASE | PASS |
| WHATSAPP ACCOUNT MODEL | PASS |
| CONTACTS | PASS |
| CHATS | PASS |
| GROUPS | PASS |
| MESSAGES | PASS |
| MEDIA | PASS |
| CALL EVENTS | PASS |
| STATUSES | PASS |
| PRESENCE | PASS |
| SYNC JOBS | PASS |
| JID PRESERVATION | PASS |
| @LID | PASS |
| CONTACT NAME LINKING | PASS |
| DUPLICATE PROTECTION | PASS |
| TENANT ISOLATION | PASS |
| RESTART PERSISTENCE | PASS |
| DATABASE FAILURE | PASS |
| TYPECHECK | PASS |
| TESTS | PASS (36/36) |
| MOCK DATA | NONE |
| FAKE DATA | NONE |
| SECRETS COMMITTED | NONE |

## What was built

- **16 SQL migrations** (`src/db/migrations/001`-`016`), applied via a real migration runner (`src/db/migrate.ts`, `npm run db:migrate`) that tracks state in `schema_migrations` and is idempotent (verified: re-running after a clean apply reports "Already up to date").
- **Tables**: `businesses` (bootstrap tenant - see Known Limitations), `whatsapp_accounts`, `whatsapp_contacts`, `whatsapp_groups`, `whatsapp_group_members`, `whatsapp_chats`, `whatsapp_messages`, `whatsapp_message_reactions`, `whatsapp_media`, `whatsapp_presence`, `whatsapp_calls`, `whatsapp_statuses`, `whatsapp_connection_events`, `whatsapp_sync_jobs`, `whatsapp_jid_mappings`. Every table carries `business_id` (+ `whatsapp_account_id` where applicable) for tenant/account isolation, matching the spec field-by-field with a few explicit, documented deviations (below).
- **Repository layer** (`src/repositories/`): one class per entity, parameterized queries only, no arbitrary SQL, no ORM. Routes never touch Postgres directly (`route -> service -> repository -> database`, enforced by the persistence service being the only caller of repositories from the connection service).
- **Domain layer** (`src/domain/whatsapp/`): `jid.ts` (JID classification + phone derivation, refactored out of the Phase 2B ingestion service so both layers share one implementation), `displayName.ts` (priority-ordered name resolver: verified > business > display > push > short > phone > JID, never fabricates), `types.ts` (shared enums matching every CHECK constraint).
- **The real transaction**: `WhatsAppMessagePersistenceService.persist()` runs `BEGIN` -> upsert contact -> upsert chat -> insert message (deduplicated by the DB-level unique index on `(business_id, whatsapp_account_id, whatsapp_message_id)`, not application logic) -> record chat's last message -> insert media metadata if applicable -> `COMMIT`, with automatic `ROLLBACK` on any failure. Wired live into `whatsappConnectionService`'s `messages.upsert` handler, and the real connected account is now persisted (`whatsapp_accounts`, `whatsapp_connection_events`) on every real `connection.update`.
- **`GET /api/health/database`**: reports `DATABASE_UNAVAILABLE` / 503 honestly when Postgres is unreachable, `CONNECTED` / 200 with real latency-free `SELECT 1` check otherwise.
- **36 tests** (`test/*.test.ts`, `npm test`) run against a real Postgres database (`whatchatai_test`), not mocks: contact create/upsert/rename, @lid preservation + no-fabrication, phone JID preservation, group JID preservation, contact/chat linking surviving a rename, message insert, duplicate prevention, historical flag, live flag, message status transition, reaction (FK-enforced against a real message), media metadata (no fake transcript), call event lifecycle (offer -> ended on one row), presence as an append-only log, status insert, sync job lifecycle, transaction rollback (real `BEGIN`/`ROLLBACK`, verified no partial row survives), and cross-business tenant isolation (same JID, two businesses, two isolated rows, no cross-tenant lookup).

## Manual tests (outside the automated suite, run for real)

- **Restart persistence**: inserted a real contact row via the repository layer, killed the running Node process, started a fresh process, queried the same row from the fresh process. Same ID, same data, confirmed.
- **Database failure**: stopped the real `postgresql` service while the app was running. `GET /api/health/database` correctly returned 503 `DATABASE_UNAVAILABLE` with the real connection error, and other endpoints (`/api/health`) kept working. **This test caught a real bug**: `pg.Pool` had no `error` listener, so the idle-client connection-loss event was unhandled and crashed the Node process instead of being reported as `DATABASE_UNAVAILABLE`. Fixed by attaching `pool.on('error', ...)` in `src/db/pool.ts`. Re-ran the test after the fix: the process now survives the outage, and self-heals (`CONNECTED` again) the moment Postgres restarts, without needing an app restart.

## Explicit deviations from the literal spec (and why)

- **`businesses` table added.** Not in the spec's table list, but every table's `business_id` FK needs a real target, and Authentication + Multi-Tenant hasn't been built yet. A single bootstrap row (`BusinessRepository.ensureDefault()`) stands in until that phase exists - this is real infrastructure the app needs to run, not fabricated WhatsApp data.
- **`recipient_jid` on `whatsapp_messages` is nullable**, not required as the field list implied - "recipient" is ambiguous for group messages, so it's derived only for individual chats.
- **Group JID mapping (`whatsapp_jid_mappings.source`) uses `baileys_alt_jid`** instead of a generic string, naming the one real source this app currently trusts (Baileys' `key.remoteJidAlt`) rather than leaving it open to an unverified value.

## Known limitations (explicitly deferred, not silently skipped)

- **No live event wiring yet for**: groups/group members, calls, presence, statuses, reactions, full contact/chat/group sync. The tables and repositories exist and are tested against real Postgres; nothing subscribes to those Baileys events yet, so nothing gets inserted for them today. That is correct per this phase's scope ("do not implement every synchronization worker yet") - no fake rows exist, and no code claims these are being tracked live.
- **No media download worker.** `whatsapp_media` rows are created with real metadata (mimetype, filename) at message-insert time with `download_status = 'pending'`; no bytes are fetched, no transcript is fabricated.
- **Single-tenant bootstrap** until Authentication + Multi-Tenant Business Layer is built (see "Explicit deviations" above). The schema is already tenant-isolated and tested for it; only real signup is missing.
- **`whatsapp_chats.contact_id` / `.group_id`** are wired for individual chats now; group chats get `chat_type = 'group'` and `is_group = true` today, with `group_id` populated once group sync (Phase 3) creates the corresponding `whatsapp_groups` row.

## Files changed

- Added: `src/db/pool.ts`, `src/db/transaction.ts`, `src/db/migrate.ts`, `src/db/migrations/001`-`016_*.sql`
- Added: `src/domain/whatsapp/jid.ts`, `displayName.ts`, `types.ts`
- Added: `src/repositories/*.ts` (15 files: business + 14 entity repositories)
- Added: `src/services/whatsappMessagePersistenceService.ts`
- Added: `test/*.test.ts` (9 files, 36 tests), `test/helpers.ts`, `test/globalSetup.ts`, `vitest.config.ts`
- Modified: `src/services/whatsappConnectionService.ts` (persists real account + connection events, routes ingested messages through the persistence transaction), `src/services/whatsappMessageIngestionService.ts` (reuses the shared `domain/whatsapp/jid` module instead of a local copy), `src/server/index.ts` (`GET /api/health/database`), `package.json` (`pg`, `@types/pg`, `vitest`, `db:migrate`/`test` scripts), `.env.example` (`DATABASE_URL`), `README.md`, `docs/ARCHITECTURE.md`

## Do not proceed to full synchronization workers until this phase is reviewed and accepted.
