# WhatchatAI

Production-first multi-tenant AI WhatsApp SaaS.

This repository is being built from the ground up using a phased, page-by-page implementation strategy.

## Production Truth Rules

- No mock production data.
- No fake WhatsApp states, messages, contacts, calls, battery levels, analytics, or integration states.
- Real services and real persisted data only.
- Unsupported capabilities must be shown as unsupported rather than simulated.
- One authoritative AI orchestration path.
- One authoritative outbound WhatsApp dispatcher.
- Original WhatsApp JIDs are preserved exactly as received.
- Historical messages never trigger live AI responses.

## Current phase

Phase 1 (foundation), Phase 2A (real QR/Baileys connection), and Phase 2B (real inbound message ingestion) are implemented. Phase 2C (database + WhatsApp data model + persistence) is implemented: a 16-table Postgres schema, a parameterized repository per entity, and a real `BEGIN`/`COMMIT` transaction that persists every live-ingested message (contact -> chat -> message -> media metadata), all tenant-scoped by `business_id`. Phase 2C was then extended with the SaaS foundation (plans, entitlements, subscriptions, AI agents, CRM contacts, leads) required by the wider product directive - 25 migrations and 52 tests total, all against real Postgres. See `docs/ARCHITECTURE.md`, `docs/PHASE_2C_REPORT.md`, and `docs/PHASE_2C_SAAS_FOUNDATION_REPORT.md` for details. Full contact/chat/group synchronization, the WhatsApp workspace/inbox UI, billing UI, and the automation engine are later phases, not yet built.

## Development database

```
DATABASE_URL=postgres://whatchatai:whatchatai_dev@localhost:5432/whatchatai_dev
npm run db:migrate   # apply migrations (25 total)
npm test              # runs 52 tests against a real whatchatai_test Postgres database
```
