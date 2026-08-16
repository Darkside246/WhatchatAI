# WhatsApp Sync, Identity, Call & Status Repair — Audit Report

Scope: repair the WhatsApp synchronization architecture (identity resolution,
message classification, call state machine, status ingestion) with no
fabricated data. Full media binary storage/serving is explicitly **not**
part of this pass — see "Known limitations."

## Sync audit

Numbers below are real counts, queried live against this environment's
database at the time of writing. This sandbox has no paired WhatsApp
account, so all counts are 0 — that is itself an honest, real result, not a
placeholder. Run the same query against your own `whatsapp_dev` database
(where a real account is connected) for live numbers:

```sql
SELECT
  (SELECT count(*) FROM whatsapp_contacts) AS contacts,
  (SELECT count(*) FROM whatsapp_chats) AS chats,
  (SELECT count(*) FROM whatsapp_groups) AS groups,
  (SELECT count(*) FROM whatsapp_messages) AS messages,
  (SELECT count(*) FROM whatsapp_media) AS media,
  (SELECT count(*) FROM whatsapp_statuses) AS statuses,
  (SELECT count(*) FROM whatsapp_calls) AS calls,
  (SELECT count(*) FROM whatsapp_calls WHERE status IN ('offer','ringing')) AS calls_stuck_ringing,
  (SELECT count(*) FROM whatsapp_messages WHERE message_type='unknown') AS unclassified_messages;
```

Contacts imported: not measured in this session (no live account here)
Contacts with unresolved identity: not measured in this session
Contacts reconciled: verified functionally (see Contact identity resolution below), not counted in production
Duplicate contacts prevented: verified functionally (unique `(business_id, whatsapp_account_id, whatsapp_jid)` index + tests), not counted in production
Chats imported: not measured in this session
Groups imported: not measured in this session
Messages imported: not measured in this session
Media imported (metadata only, see limitations): not measured in this session
Videos imported (metadata only): not measured in this session
Stickers imported (metadata only): not measured in this session
Voice notes imported (metadata only): not measured in this session
Documents imported (metadata only): not measured in this session
Statuses imported: not measured in this session (ingestion path is new as of this pass)
Status media imported: **NONE** — media download is deferred, see limitations
Call events imported: not measured in this session
Calls stuck in RINGING: **FIXED** at the code level (see below); real count depends on your live data
Calls reconciled: real, automated (30s sweep, 60s documented timeout rule)
Orphaned messages: not audited this session (no orphan-detection job built)
Orphaned media: not audited this session
Unknown contacts remaining: not measured in this session

## What was actually fixed (real, tested, code-level)

1. **Message classification gap.** `buttonsMessage`, `buttonsResponseMessage`,
   `templateButtonReplyMessage`, `templateMessage`, `listMessage`,
   `listResponseMessage`, `interactiveMessage`, `interactiveResponseMessage`,
   `groupInviteMessage`, `pollUpdateMessage`, `contactsArrayMessage`
   (distinct from single-contact `contactMessage`), and `editedMessage`
   (unwrapped to its real underlying content) were previously unhandled and
   fell into `message_type = 'unknown'`. All now route to the schema's
   already-existing `button`/`interactive`/`poll_response`/`contacts` values.
   Real tests: `test/whatsappMessageClassification.test.ts` (6 tests).

2. **Calls permanently stuck in RINGING.** Root cause: Baileys is not
   guaranteed to send a follow-up event for an unanswered call. A real,
   documented reconciliation job (`sweepStaleRingingCalls`, a BullMQ
   repeatable job every 30s) transitions any call still in `offer`/`ringing`
   past a 60-second threshold — WhatsApp's own client rings for roughly
   45–60s before showing a missed call — to `timeout`. This never touches a
   call that already reached a real terminal state. Real tests:
   `test/callTimeoutReconciliation.test.ts` (3 tests).

3. **Call duration bug.** Previously computed from `offer` time to `end`
   time — i.e. *ring time*, not *talk time*. A missed/rejected call would
   have shown a fabricated-looking duration. Added `accepted_at` to the
   schema (migration `029_add_whatsapp_calls_accepted_at.sql`); duration is
   now `ended_at - accepted_at`, and is `NULL` (never a number) for any call
   that was never answered. `'accepted'` was also incorrectly treated as a
   terminal status (accepting a call doesn't end it) — fixed. Real tests:
   `test/realtimeEventsQueue.test.ts`.

4. **Status ingestion never existed.** Baileys has no dedicated status event
   — status updates arrive via `messages.upsert` on the fixed
   `status@broadcast` JID, and were previously either dropped or
   (before last session's chat-list fix) shown mixed into the chat list.
   They now route to the real `whatsapp_statuses` table (never
   `whatsapp_messages`/`whatsapp_chats`), with real `status_type` derived
   from content, real 24h `expires_at` (WhatsApp's actual, documented status
   lifetime), and identity resolved through the same contact/JID-mapping
   pipeline as chats. `GET /api/workspace/statuses` added. Real tests:
   `test/statusUpdateRouting.test.ts` (2 tests).

5. **Contact identity reconciliation — verified, not rebuilt.** The
   NULL-merge-protection (`COALESCE(EXCLUDED.x, table.x)` on every mutable
   identity field) and JID-based (never name-based) contact matching were
   already correctly built in an earlier phase. Verified end-to-end with a
   new real-database test proving the exact "message arrives before contact
   metadata, richer data arrives later" scenario resolves to one canonical
   contact with no duplicate, and that a later NULL never erases a known
   name. `test/contactReconciliation.test.ts` (2 tests).

6. **Premium UI pass.** Every emoji-as-icon across the app (nav rails, chat
   list, thread, delivery ticks, call history, lock screen) replaced with
   real SVG icons (`lucide-react`), tree-shaken (~6KB gzipped added to the
   bundle for the full icon set actually used).

## PASS / FAIL / UNSUPPORTED

- JID integrity: **PASS** — `@lid` is preserved verbatim everywhere; phone
  numbers are only ever derived from a genuine `remoteJidAlt` or an
  authoritative `whatsapp_jid_mappings` row, never by string-stripping a lid.
- @LID integrity: **PASS** — same as above; `whatsapp_jid_mappings` is the
  only source of lid→phone resolution, sourced from Baileys' own
  `lidPnMappings`/`contacts.upsert`, never inferred.
- Contact name resolution: **PASS** — priority order
  (verifiedName → businessName → displayName → pushName → shortName →
  phoneNumber → JID), NULL-merge-protected, JID-matched, verified with
  real reconciliation tests.
- Media file integrity: **UNSUPPORTED (deferred)** — see limitations. No
  binary download/storage/checksum pipeline exists; only metadata is
  captured today.
- Video file / Sticker file / Voice file: **UNSUPPORTED (deferred)** —
  same reason.
- Status import: **PASS** (ingestion, identity, expiry) /
  **UNSUPPORTED** (status media download — same media-pipeline gap).
- Call state machine: **PASS** — real offer→ringing→accepted→ended/rejected/
  missed/timeout transitions, real duration semantics, real timeout
  reconciliation.
- Restart safety: **PASS** — every write path uses a real unique-index
  `ON CONFLICT` (messages by `whatsapp_message_id`, calls by `call_id`,
  statuses by `status_id`, contacts by `whatsapp_jid`); BullMQ's
  `upsertJobScheduler` is idempotent by scheduler id, so the timeout-sweep
  schedule survives worker restarts without duplicating.
- Tenant isolation: **PASS** — every query in every repository is scoped by
  `business_id` (and `whatsapp_account_id` where applicable); this was
  already enforced throughout and is unchanged.
- Fake data: **NONE FOUND** (repo-wide grep for fake/mock/simulate/dummy/
  placeholder/555/battery-level patterns reaching production — clean).
- Simulation: **NONE FOUND**.

## Known limitations (explicitly deferred, not silently skipped)

- **Media binary pipeline (download, checksum, encrypted storage, secure
  serving API) is not built.** The schema (`sha256`, `storage_provider`,
  `storage_reference`, `download_status`, `processing_status`) has existed
  since an earlier phase and is honestly still `download_status: 'pending'`
  for every media message — never marked `downloaded` without real bytes.
  This is a substantial, security-sensitive feature (storage backend choice,
  encryption at rest, tenant-isolated signed serving) that deserves its own
  dedicated pass rather than a rushed implementation in the same session as
  everything above.
- **Status media** depends on the same media pipeline — text-only statuses
  are fully real today; image/video/audio statuses are ingested with correct
  metadata but no downloaded file.
- **Orphan detection / repair job** (scanning for orphaned messages, media,
  unresolved contacts at scale) was not built as a standalone job. The
  reconciliation mechanisms that exist (NULL-merge-protected upserts,
  fresh-per-request identity resolution) are continuous and automatic, so
  the main scenario the directive worried about — "Unknown never gets
  reconciled" — is verified not to occur. A dedicated sweep/dashboard for
  visibility into remaining orphans is future work.
- **Live WhatsApp calling is not supported by the current connector** —
  Baileys only reports call *events*, it cannot place or answer calls. The
  UI does not claim otherwise.
- Real measured production counts (contacts/chats/messages/media/statuses/
  calls) are not available from this sandbox, which has no paired WhatsApp
  account. Run the query at the top of this report against a real connected
  environment.
