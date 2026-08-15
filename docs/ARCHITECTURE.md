# WhatchatAI Architecture

## Build principle

The platform is built one page and one production capability at a time. A page is not considered complete until its backend data source, error states, authentication boundaries, persistence, and live integration are connected.

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
- `src/services/persistence`: database repositories and migrations.
- `src/web`: responsive management UI.

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

Persistence (chats, contacts, messages durably stored with an audit trail) is Phase 3 work, not part of 2B.

### Phase 3 - Full synchronization

Import real contacts, active chats, groups, profile pictures, message history, timestamps, unread state, statuses where the connection exposes them, and media metadata. Preserve original JIDs.

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
