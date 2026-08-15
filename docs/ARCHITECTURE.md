# WhatchatAI Architecture

## Build principle

The platform is built one page and one production capability at a time. A page is not considered complete until its backend data source, error states, authentication boundaries, persistence, and live integration are connected.

**Product direction:** WhatchatAI is a WhatsApp-first business operating platform (WhatsApp + AI agents + CRM + automation + analytics + billing), not just a chatbot. The full 20-phase roadmap (Foundation → WhatsApp connection → database → sync → workspace → messaging → Gemini → agents → multimodal → CRM/leads → automation → knowledge base → analytics → marketing → Google integrations → billing/entitlements → teams → admin → security → certification) lives in the product directive; this document's phase numbering below is reconciled against it as each phase is actually reached. Nothing here changes retroactively without a corresponding completed phase.

## Reference workflow

The supplied multimodal workflow is the architectural guide for the processing pipeline:

`WhatsApp event -> message/media classification -> real media retrieval -> multimodal processing -> conversation context -> knowledge/memory -> AI response -> WhatsApp outbound dispatcher -> delivery state -> persistent audit`

The visual workflow is a guide, not a source of fake data or simulated services.

## Non-negotiable production rules

1. Never create fake contacts, chats, messages, unread counts, profile data, battery levels, connection states, delivery receipts, call states, analytics, or AI responses.
2. If a capability is unavailable through the selected WhatsApp connection, expose that limitation honestly in the UI.
3. Preserve WhatsApp identifiers exactly as received. In particular, do not convert `@lid` JIDs into `@s.whatsapp.net` JIDs for storage or routing.
4. Keep phone-number extraction separate from JID identity.
5. Historical synchronization must never invoke the live AI responder.
6. Every outbound AI response must pass through one dispatcher so duplicate sends cannot occur.
7. Gemini calls must use the configured model and must log health/latency/errors without exposing secrets.
8. Voice notes must be downloaded and retained before transcription/interpretation. The AI must receive the actual audio bytes, not a synthetic prompt describing the audio.
9. Images and documents must be downloaded and processed as actual attachments. The system must preserve MIME type, source message ID, and storage identity.
10. All persistent data must have an authoritative database record and an audit trail.

## Service boundaries

- `src/server`: HTTP API and application composition.
- `src/services/whatsapp`: Baileys connection, QR authentication, event ingestion, synchronization, media retrieval, delivery receipts.
- `src/services/ai`: Gemini client, multimodal processing, conversation orchestration, tool execution policy.
- `src/services/dispatch`: single outbound WhatsApp dispatcher.
- `src/domain/whatsapp`: shared JID classification, display-name resolution, and domain types - no I/O.
- `src/db`: connection pool, health check, transaction helper, and SQL migrations.
- `src/repositories`: one parameterized-query repository per persisted entity. Routes never touch Postgres directly.
- `src/web`: responsive React + Vite + Tailwind UI (npm workspace). `npm run dev` runs it alongside the backend; `npm run build` produces a static bundle the Express server serves directly in production (one process, one port). See `docs/APP_BINDING_REPORT.md` for the onboarding -> sync -> workspace flow this drives.
- `src/queue`: BullMQ queues/workers (Redis-backed). `src/queue/queues/incomingMessagesQueue.ts` is the speed-layer entry point; `src/queue/workers/incomingMessagesWorker.ts` is a standalone process (`npm run dev:worker`) that runs the Sentinel and persistence off the Baileys event loop.
- `src/security`: `src/security/encryption` (AES-256-GCM envelope encryption, envelope-based Tenant Data Key derivation, Redis-cached with a 15-minute TTL) and `src/security/sentinel` (Stage 1 heuristic shield + Redis rate limiting, Stage 2 Gemini Flash prompt-injection/jailbreak classifier).
- `src/redis`: shared Redis client for caching and rate limiting, separate from BullMQ's own dedicated connections (`src/queue/connection.ts`).

## Zero-trust security & speed-layer pipeline

Live message ingestion is fully decoupled from the API/UI process:

1. `messages.upsert` (Baileys) classifies the payload in memory (no I/O) and pushes it onto the `incoming_messages` BullMQ queue - no synchronous Postgres write happens on that event-loop turn.
2. A separate worker process (`src/queue/workers/incomingMessagesWorker.ts`) drains the queue. Per message it runs the Tiered Security Sentinel (`src/security/sentinel/sentinel.ts`) before any business logic:
   - Stage 1 (heuristic shield): regex checks for malicious links/spam signatures, executable MIME/extension blocking, payload size limits, and a real Redis token-bucket rate limit (10 msgs/10s per sender).
   - Stage 2 (AI sentinel): surviving text is checked by a Gemini Flash model with strict JSON-schema output (`{safe, reason}`) for prompt injection, jailbreak, and social-engineering intent. If `GEMINI_API_KEY` is unset or the call fails, this fails OPEN and honestly logs `sentinel_ai_unavailable` - it never fabricates a safe verdict. Stage 1 remains the enforced gate in that case.
   - Every verdict is written to `security_audit_logs` (see migration 028); `rawMetadata` never carries message text, contact names, or phone numbers.
3. Messages the Sentinel allows are persisted via the existing transactional path (`WhatsAppMessagePersistenceService`). `text_content` is stored as an AES-256-GCM envelope (`src/security/encryption`), transparently encrypted on write and decrypted on read by `WhatsAppMessageRepository` - callers still see plaintext.
4. For a new, live, inbound message in an `AI_ACTIVE` chat, `gatherAiHandoffContext` (`src/services/aiContextGathererService.ts`) runs CRM lookup, conversation history, and knowledge-base search concurrently via `Promise.all()`. Knowledge-base vector search has no backend yet and honestly reports `available: false` rather than inventing results; wiring this context into a real Gemini Orchestrator reply is a later phase.

## Application Lock Mode

`src/web/src/components/ScreenLock.tsx` overlays the workspace on a 5-minute idle timeout or Alt+L, without pausing any background service - Baileys, the BullMQ worker, and the API server are separate Node processes untouched by UI lock state. The PIN (6-8 digits) is hashed client-side with Argon2id (`hash-wasm`, WASM) before it ever reaches the server; the server only ever sees hex hashes and salts (`src/services/securityLockService.ts`, `POST /api/security/lock/setup|unlock`). Ten consecutive failed attempts permanently revoke the lock (a real, audited `lock_revoked` state) - full forced re-login isn't wired because this codebase has no session/auth system yet.

`src/web/src/components/AlertNotifier.tsx` polls `GET /api/security/alerts/human-takeover` and renders a pulsing amber/red banner + Web Audio chime for chats in `HUMAN_TAKEOVER` mode. It always renders, independent of the lock screen's state. Zero-Leak Rule: the endpoint (`src/services/securityAlertService.ts`) exposes only a stable per-business line ordinal and an unread-count-derived urgency tier - never message text, contact names, or phone numbers.

## Phase sequence

### Phase 1 - Foundation

Health endpoints, configuration validation, logging, strict TypeScript, service boundaries, no mock production state.

### Phase 2 - WhatsApp connection

Implement the real QR/Baileys session. Persist session state securely. Expose real connection state only. Register one socket with the dispatcher.

**Phase 2A (done):** real Baileys socket, QR generation, connection status reporting.

**Phase 2B (done):** real inbound message ingestion. The connection service forwards every `messages.upsert` event from the live socket to `whatsappMessageIngestionService`, which:

- Preserves `remoteJid` exactly as received, including `@lid` identifiers - it is never rewritten to a phone-based JID.
- Derives a phone number only from a genuine phone-based JID (`@s.whatsapp.net`/`@c.us`), or from Baileys' own `remoteJidAlt` counterpart when the conversation is `@lid`-addressed. A phone number is never guessed from `@lid` digits.
- Classifies content deterministically from the actual message payload (text, image, video, voice note vs. audio file, document with pdf/spreadsheet/other sub-typing, sticker, location, contact, reaction, poll, system), unwrapping ephemeral/view-once/caption envelopes first.
- Marks each message `isLive` based on Baileys' own upsert type (`notify` = live, anything else = historical/synced), so historical import can never be mistaken for a live event.
- Holds ingested messages in a bounded in-memory buffer only - there is no database yet, so nothing here is described as "saved" or "persisted". `GET /api/whatsapp/messages/recent` and `GET /api/whatsapp/messages/stats` expose this buffer for verification and say so explicitly.

**Phase 2C (done):** database + WhatsApp data model + persistence. See `docs/PHASE_2C_REPORT.md` for the full completion report. Summary:

- 16 Postgres migrations (`src/db/migrations`) covering `businesses` (bootstrap tenant), `whatsapp_accounts`, `whatsapp_contacts`, `whatsapp_groups`, `whatsapp_group_members`, `whatsapp_chats`, `whatsapp_messages`, `whatsapp_message_reactions`, `whatsapp_media`, `whatsapp_presence`, `whatsapp_calls`, `whatsapp_statuses`, `whatsapp_connection_events`, `whatsapp_sync_jobs`, and `whatsapp_jid_mappings` - every table tenant-scoped by `business_id` (+ `whatsapp_account_id` for multi-account isolation).
- A parameterized-query repository per entity (`src/repositories`) - no arbitrary SQL, no ORM magic, `route -> service -> repository -> database` only.
- `WhatsAppMessagePersistenceService` (`src/services/whatsappMessagePersistenceService.ts`) is the one real write transaction for an incoming message: upsert contact -> upsert chat -> insert message (deduped by a DB unique index on `whatsapp_message_id`) -> record chat's last message -> (if media) insert media metadata, all in `BEGIN`/`COMMIT`, rolled back atomically on any failure. Wired live into `whatsappConnectionService`'s `messages.upsert` handler.
- The real connected account and connection history are now persisted (`whatsapp_accounts`, `whatsapp_connection_events`) instead of only living in the in-process snapshot.
- `GET /api/health/database` reports `DATABASE_UNAVAILABLE` (503) honestly when Postgres is down, and the app now survives a DB outage without crashing (a real `pg.Pool` idle-client-error bug was found and fixed by this phase's own database-failure test).
- @lid handling: `whatsapp_jid` is always stored exactly as received; a phone number is only ever attached when it comes from a genuine `@s.whatsapp.net`/`@c.us` JID or Baileys' own `remoteJidAlt` mapping (persisted for provenance in `whatsapp_jid_mappings` when used) - never parsed out of `@lid` digits.
- 36 tests (`test/`, `npm test`) run against a real Postgres database (`whatchatai_test`), not mocks - contact upsert/rename, @lid/phone/group JID preservation, contact/chat linking survives a rename, message dedup, historical vs. live flag, message status, reactions (FK-enforced), media metadata, call event lifecycle, presence log, statuses, sync job lifecycle, transaction rollback, and cross-business tenant isolation.
- Explicitly deferred (schema exists, live wiring does not): full contact/chat/group sync workers, group membership sync, presence/call/status event subscription, media download, and AI processing - all Phase 3+ work per the phase plan below.
- Known simplification: Authentication + Multi-Tenant hasn't been built yet, so a single bootstrap `businesses` row stands in for real tenant signup until that phase exists.

**Phase 2C SaaS foundation extension (done):** the database/data-model foundation for the wider SaaS product (subscriptions, entitlements, AI agents, CRM), added without touching any of the WhatsApp work above. See `docs/PHASE_2C_SAAS_FOUNDATION_REPORT.md`. Summary:

- 9 more migrations (`017`-`025`): `plans` + `plan_entitlements` (seeded with 4 real tiers), `subscriptions` + `subscription_events` (one live subscription per business enforced at the DB level), `usage_counters`, `ai_agents` (full persona/instruction/tool/knowledge-source config), `crm_contacts` (built around a real `whatsapp_contacts` identity, never duplicated), `leads`.
- 7 more repositories, same parameterized pattern.
- `EntitlementService` (`src/services/entitlementService.ts`): real backend enforcement - `canCreateAgent` / `canConnectWhatsAppAccount` check the business's actual subscription + plan entitlement + a real count, not a hidden UI button. Not yet wired to any API route (no route/UI exists yet to enforce - that's a later phase).
- 16 more tests (52 total), all against real Postgres, including entitlement-limit-reached and tenant-isolation scenarios.
- Explicitly not built yet: any billing provider integration, usage metering, agent routing, or CRM/agent/billing API routes or UI - per the directive's own "do not jump ahead" instruction.

### Phase 3 - Full synchronization

Import real contacts, active chats, groups, profile pictures, message history, timestamps, unread state, statuses where the connection exposes them, and media metadata into the Phase 2C schema. Preserve original JIDs.

### Phase 4 - Messaging

Real inbound/outbound text messages, receipts, retry/error handling, idempotency, duplicate-send protection, and operator takeover.

### Phase 5 - Multimodal AI

Text, voice notes, images, PDFs, office documents, audio, and supported video. Media is persisted before AI interpretation. AI context must reference actual extracted/transcribed content.

### Phase 6 - Dashboard pages

Build each page separately and connect it to live API data before moving to the next page. Responsive layouts must support desktop, tablet, and mobile widths without unreadable content. Long pages use internal scrolling rather than overflowing the viewport.

### Phase 7 - Multi-agent controls

Allow multiple WhatsApp agent configurations while isolating credentials, sessions, chats, prompts, memory, permissions, and outbound dispatch per agent/tenant.

### Phase 8 - Production validation

Typecheck, build, dependency audit, security review, integration tests, real WhatsApp test messages, real media tests, persistence/restart tests, duplicate-send tests, and deployment validation.

## Definition of done

A feature is done only when the UI, API, persistence, external integration, error handling, security boundaries, and tests agree on the same real state. A green UI element is never allowed to claim success based on hardcoded or simulated data.
