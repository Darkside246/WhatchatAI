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

Phase 1 (foundation), Phase 2A (real QR/Baileys connection), Phase 2B (real inbound message ingestion), and Phase 2C (database + WhatsApp data model + SaaS foundation - plans, entitlements, subscriptions, AI agents, CRM, leads) are implemented - 26 migrations, real Postgres persistence throughout. A real (minimal) Phase 3 synchronization worker, a responsive React frontend (`src/web`), and the onboarding → sync → workspace flow are now implemented too. See `docs/ARCHITECTURE.md`, `docs/PHASE_2C_REPORT.md`, `docs/PHASE_2C_SAAS_FOUNDATION_REPORT.md`, and `docs/APP_BINDING_REPORT.md` for details. Outbound messaging, the full CRM/automation/billing UI, and multimodal AI are later phases, not yet built.

## Running it

```
DATABASE_URL=postgres://whatchatai:whatchatai_dev@localhost:5432/whatchatai_dev
npm install
npm run dev    # runs migrations, then the backend (:3000) and frontend (:5173) together
npm test        # runs 56 tests against a real whatchatai_test Postgres database
npm run build   # real production build: compiled backend + Vite bundle
npm start       # runs the API/web process and the AI-reply queue worker together (`npm start` alone used to skip the worker - AI replies never fired in production; fixed)
```
