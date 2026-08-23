# Phase 1: WhatsApp Status Text Fix — Implementation Proposal

**Status: proposal only. No code changes in this document.** Scope is
exactly the defect Phase 0 root-caused
(`docs/PHASE_0_MASTER_DIRECTIVE_AUDIT.md`, Section A1-A4) — the missing
`status@broadcast` split in the historical-sync ingestion path. Nothing
else. The live `messages.upsert` path, persistence schema, API, and
frontend are all already correct and are not touched.

---

## 1. Exact root cause, restated precisely

`whatsappConnectionService.ts:316-327` (the live `messages.upsert`
handler) splits ingested messages by `remoteJid === STATUS_BROADCAST_JID`
before persistence — status content goes to `enqueueStatusUpdates`, chat
content goes to `enqueueIngestedMessages`.

`whatsappSyncService.ts:227-251` (`ingestHistoryMessages`, invoked from
`ingestHistorySet` for Baileys' `messaging-history.set` event — the
event carrying a business's already-active Statuses at pairing time) has
**no equivalent split**. It classifies every message with the same
`whatsappMessageIngestionService.ingestUpsert`, then calls
`whatsappMessagePersistenceService.persist(...)` unconditionally for
every one of them, including `status@broadcast` messages. Because
`classifyJid('status@broadcast')` returns `'broadcast'` — a value the
`whatsapp_chats`/`whatsapp_contacts` schema's `jid_kind`/`chat_type`
CHECK constraints already permit — this does not fail. It silently
creates a phantom `status@broadcast` "chat" and files the status content
into `whatsapp_messages`, where the Status UI never looks.

## 2. Why this cannot be a one-line fix

The live path's split feeds two different **execution models**, not
just two different tables:

- `enqueueIngestedMessages`/`enqueueStatusUpdates` both hand off to
  BullMQ jobs (`incomingMessagesWorker.ts`), processed asynchronously in
  the separate worker process.
- `ingestHistoryMessages`, by contrast, calls
  `whatsappMessagePersistenceService.persist(...)` **synchronously**,
  in-process, from `src/server/index.ts` (confirmed: `whatsappConnectionService`
  — and everything it calls, including `whatsappSyncService.ingestHistorySet`
  — is only ever imported by `server/index.ts`, never by
  `incomingMessagesWorker.ts`; there is no queue hop for historical
  messages today).

Simply calling `enqueueStatusUpdate` from inside `ingestHistoryMessages`
would introduce a queue hop that doesn't exist for historical chat
messages either, and would need its own idempotency/ordering reasoning
against a sync job that can legitimately replay batches (`startInitialSync`'s
existing "already completed" short-circuit exists precisely because
Baileys can resend history-set batches). That is more change than this
defect requires.

The **status-row persistence logic itself already exists**, correctly,
inline inside `processStatusUpdate` (`incomingMessagesWorker.ts:411-449`)
— insert the `whatsapp_statuses` row, and if it's a real new insert with
media, insert the `whatsapp_media` placeholder row, attach it, and queue
just the media *download* (not the row creation) via `enqueueMediaDownload`.
That queued-download step is correct and desired for both the live and
historical paths equally — actually downloading bytes should never block
either ingestion path.

## 3. Proposed minimal change

**Extract, don't duplicate, don't redesign.** Move the status-persistence
logic (currently inline in `processStatusUpdate`) into one small, shared,
synchronous function both call:

- **New file: `src/services/whatsappStatusPersistenceService.ts`**
  (mirrors `whatsappMessagePersistenceService.ts`'s existing shape and
  naming convention exactly — one persistence service per concern, this
  codebase's established pattern). Exports one function:

  ```ts
  export async function persistStatusUpdate(
    businessId: string,
    whatsappAccountId: string,
    ingested: IngestedWhatsAppMessage,
  ): Promise<void>
  ```

  Its body is the existing `processStatusUpdate` logic, moved verbatim
  (status insert → `wasInserted` check → media row insert/attach →
  `enqueueWithTimeout(enqueueMediaDownload(...))` for the download only).
  No behavior change for what this function does — only where it lives.

- **`incomingMessagesWorker.ts`**: `processStatusUpdate` becomes a thin
  wrapper calling `persistStatusUpdate(data.businessId, data.whatsappAccountId, data.ingested)`.
  `mapContentTypeToStatusType`/`mapStatusTypeToMediaType`/`STATUS_TTL_MS`
  move with the logic into the new file (they're private helpers of this
  exact logic, not used elsewhere in the worker). Zero behavior change
  for the live path — this is a pure extraction, verified by the
  existing status/media tests continuing to pass unmodified.

- **`whatsappSyncService.ts`**: `ingestHistoryMessages` gains the same
  split the live handler already has, then calls `persistStatusUpdate`
  synchronously (matching how it already calls
  `whatsappMessagePersistenceService.persist` synchronously for chat
  messages — no new queue hop, no new execution model):

  ```ts
  const ingested = whatsappMessageIngestionService.ingestUpsert({ messages, type: 'append' });
  const statusUpdates = ingested.filter((m) => m.remoteJid === STATUS_BROADCAST_JID);
  const chatMessages = ingested.filter((m) => m.remoteJid !== STATUS_BROADCAST_JID);

  for (const status of statusUpdates) {
    try {
      await persistStatusUpdate(businessId, whatsappAccountId, status);
    } catch (error) {
      failed += 1;
      console.error('[Sync] Failed to persist historical status', status.messageId, error);
    }
  }
  for (const message of chatMessages) {
    // existing persist() loop, unchanged
  }
  ```

- **Shared constant**: `STATUS_BROADCAST_JID` is currently a private
  `const` inside `whatsappConnectionService.ts` only. Promote it to one
  shared, exported constant (proposed home:
  `src/domain/whatsapp/types.ts`, alongside `StatusType` — the existing
  domain-types module both files can import from without new coupling
  between server-only and worker-only code). Both call sites import the
  same value instead of each hardcoding the literal string —
  the exact class of drift that caused this defect in the first place.

## 4. What this explicitly does not touch

- No change to `whatsapp_statuses`/`whatsapp_media` schema (both already
  correct, per Phase 0).
- No change to the API route (`GET /api/workspace/statuses`) or
  `workspaceService.listStatuses` (both already correct).
- No change to `StatusesPanel.tsx` or any other frontend component
  (already correct).
- No change to the live `messages.upsert` handler's own split logic
  (already correct) — only its downstream helper functions relocate,
  behavior identical.
- No change to media *download* retry behavior (that is Phase 2's
  separate, larger scope per the master directive — not entangled with
  this fix; the media-download queue step here is reused exactly as-is).
- No change to `whatsappConnectionService.ts`'s connection/pairing logic,
  QR handling, or session management — untouched.

## 5. Idempotency and replay safety

Already structurally sound, not something this change needs to add:
`whatsapp_statuses_identity_idx` (`UNIQUE (business_id,
whatsapp_account_id, status_id)`, migration 013) means a re-synced
history-set batch calling `persistStatusUpdate` a second time for the
same status simply hits the existing `ON CONFLICT ... DO NOTHING` path
in `WhatsAppStatusRepository.insert` and returns `wasInserted: false` —
identical to how `processStatusUpdate` already handles this for the live
path, and identical to how `ingestHistoryMessages`'s existing chat-message
loop already relies on `whatsapp_messages`' own equivalent unique
constraint for the same reason. No new idempotency mechanism is needed;
the existing one already covers this path once it's reachable at all.

## 6. Test plan

- **Regression (must not change)**: the existing live-status
  tests (classification/routing tests from this engagement's earlier
  Phase 47/49-era work) continue to pass unmodified against the
  extracted `persistStatusUpdate` function, proving the extraction is
  behavior-preserving.
- **New, targeted**: a test driving `ingestHistoryMessages` (or
  `ingestHistorySet`) with a synthetic `messaging-history.set`-shaped
  payload containing a `status@broadcast` text message, asserting:
  1. A real row appears in `whatsapp_statuses` with the correct
     `text_content`/`status_type`.
  2. **No** row appears in `whatsapp_chats`/`whatsapp_messages` for
     `status@broadcast` (the actual regression this fix closes).
  3. A second identical history-set replay does not create a duplicate
     status row (`wasInserted: false` on the conflict path).
  4. A historical status with media correctly creates the
     `whatsapp_media` placeholder row and enqueues exactly one download
     job (verified via a queue spy, matching this codebase's existing
     `enqueueDocumentParse`-style test convention).
  5. Cross-tenant: a history-set payload for Business A's account never
     creates a status/media row attributable to Business B.

## 7. Files changed (summary)

| File | Change |
|---|---|
| `src/services/whatsappStatusPersistenceService.ts` | New — extracted status-persistence logic |
| `src/queue/workers/incomingMessagesWorker.ts` | `processStatusUpdate` becomes a thin call into the new service; helper functions relocate |
| `src/services/whatsappSyncService.ts` | `ingestHistoryMessages` gains the same status/chat split the live handler already has |
| `src/domain/whatsapp/types.ts` | Add exported `STATUS_BROADCAST_JID` constant |
| `src/services/whatsappConnectionService.ts` | Import the shared constant instead of its own private one (one-line change, no behavior change) |
| New test file (name TBD, e.g. `test/whatsappStatusHistorySync.test.ts`) | The 5 cases in §6 |

No migration. No dependency change. No change to any file outside this
table.

---

Awaiting explicit approval of this proposal before any code is written.
