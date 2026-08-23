# Phase 2A: Media Retry — Audit and Failure-State/Idempotency Proposal

**Status: read-only audit + design proposal. No code, schema, or
configuration changes in this document.** Per the authorized workflow
(Phase 2A audit/proposal → review gate → Phase 2B implementation), this
document establishes the failure-state machine and idempotency model
before any retry code is written, and determines whether BullMQ's
existing `attempts: 3` can simply be activated or whether a more
controlled mechanism is needed.

---

## 1. Current media pipeline — every stage, traced

**Scope note, established by this audit, not assumed**: `whatsapp_media`
has four mutually-exclusive real owners as of migration 034
(`message_id` XOR `status_id` XOR `contact_id` XOR `account_id`,
enforced by `whatsapp_media_owner_check`). Of these, **message and
status media share one download pipeline** (`processMediaDownload`,
queued via `enqueueMediaDownload`/`realtimeEventsQueue`), while
**contact/account profile pictures use a completely separate, inline,
synchronous path** (`profilePictureSyncService.ts`'s own `downloadAndStore`,
a plain `fetch(url)` with no queue, no BullMQ job, "only ever fetches
once" per the code's own comment). This proposal scopes retry design to
the **message/status download pipeline only** — profile pictures are a
different, much lower-stakes problem (a missing avatar is cosmetic, not
a missing customer attachment) and mixing the two into one retry model
would violate the narrow-scope requirement. If profile-picture retry is
ever wanted, it is a separate, later proposal.

**Full trace, message/status media pipeline:**

1. **Ingestion**: `whatsappMessageIngestionService.ts`'s `classifyContent`
   identifies a downloadable media type and produces a `mediaDescriptor`
   (the encoded raw Baileys `{key, message}`, via `encodeBuffersForQueue`).
2. **Row creation**: `whatsappMessagePersistenceService.persist` (chat
   media) or `whatsappStatusPersistenceService.persistStatusUpdate`
   (status media, Phase 1) calls `WhatsAppMediaRepository.insert`,
   creating a `whatsapp_media` row with `download_status = 'pending'`
   (the column default) and no dedicated FK for exactly one of the four
   owner columns.
3. **Enqueue**: `enqueueMediaDownload({businessId, whatsappAccountId,
   mediaId, mediaDescriptor})` adds a `'media-download'` job to
   `realtimeEventsQueue`, wrapped in `enqueueWithTimeout` (fails the
   *enqueue* honestly if Redis is slow/unreachable — this part is
   already sound and unrelated to this phase's problem).
4. **Processing**: `processMediaDownload` (`incomingMessagesWorker.ts`,
   run inside `realtimeEventsWorker`, `concurrency: 5` by default —
   `INCOMING_MESSAGES_WORKER_CONCURRENCY` env-configurable):
   - `mediaRepository.setDownloading(mediaId)` — an **unconditional**
     `UPDATE ... SET download_status = 'downloading'` with no `WHERE
     download_status = 'pending'` guard and no row-count check.
   - Decodes the descriptor, calls Baileys' `downloadMediaMessage`.
   - Computes exactly one terminal outcome: `'downloaded'` (success,
     checksum verified), `'failed'` (empty buffer, oversized, checksum
     mismatch, or any thrown error that isn't a 404/410), or
     `'unavailable'` (a thrown error whose HTTP status is 404 or 410 —
     WhatsApp's CDN has genuinely expired the media).
   - On success: `storeMedia(businessId, sha256Hex, buffer)` — real,
     working content-addressed dedup (§7).
   - `mediaRepository.setDownloadResult(mediaId, status, ...)` — again
     **unconditional**, no guard, no row-count check.
   - **The function then always returns normally.** Every failure
     branch is caught internally and converted into a recorded
     `'failed'`/`'unavailable'` status — nothing is ever re-thrown.
5. **Completion signal**: on any outcome, `publishRealtimeEvent` fires
   (`media.updated` or `status.media.updated`), and for chat media, a
   successful download can trigger `maybeTriggerMediaAiHandoff`.

**Where failures currently disappear, precisely**: step 4's last point.
`realtimeEventsQueue`'s `defaultJobOptions` (`attempts: 3, backoff:
{type: 'exponential', delay: 1000}`) is real, configured BullMQ policy —
but BullMQ only re-attempts a job whose handler **rejects/throws**.
`processMediaDownload` never does. From BullMQ's perspective, every
media-download job "succeeds" on the first try, regardless of whether
the business-level outcome was `'downloaded'` or `'failed'` — so the
`attempts: 3` configuration has never fired once for this job type. This
confirms and sharpens Phase 0's finding: it is not merely "no retry
happens" — it's that **the queue's own retry machinery is present,
configured, and permanently inert** for this specific job.

**No attempt-tracking columns exist** on `whatsapp_media` (confirmed by
schema inspection, §1's full column list above) — no
`download_attempts`, no `last_attempt_at`, no `last_error_class`. A
`'failed'` row today carries no information about why, when, or how many
times.

**Frontend**: both media-rendering surfaces —
`src/web/src/components/StatusesPanel.tsx` and
`src/web/src/components/ChatThread.tsx` (confirmed this pass, resolving
Phase 0's UNVERIFIED item: `ChatThread.tsx` branches on the identical
`downloadStatus` values at the identical three states — `pending`/
`downloading`, `unavailable`, `failed`) — render a static "download
failed" message with **no retry control on either surface**. This is
one shared gap, not two separate ones.

---

## 2. Proposed failure-state machine

Extends, rather than replaces, the existing `download_status` enum —
the existing four terminal-ish values (`pending`, `downloading`,
`downloaded`, `unavailable`) remain exactly as they are; only `'failed'`
is split, and one new value is added:

```
pending             (unchanged - row created, not yet attempted)
downloading         (unchanged - a real attempt is in flight)
downloaded          (unchanged - terminal success)
retry_scheduled     (NEW - a retryable failure occurred; a future automatic
                      or manual attempt is expected, not yet running)
failed              (NARROWED - now specifically "permanently failed,
                      exhausted retries or a non-retryable error was
                      classified" - a true terminal state, not a catch-all)
unavailable         (unchanged - WhatsApp's own CDN has expired the
                      media; terminal, was already correctly distinct
                      from 'failed' in the existing 404/410 branch)
```

No `cancelled`/`invalid` state is proposed — nothing in this pipeline
today has a cancellation concept (a customer can't "cancel" media they
already sent), and inventing one would be scope beyond this defect.

**State transition table** (the actual proposed enforcement — every
transition below becomes a guarded `UPDATE ... WHERE download_status =
<expected-from>`, not an unconditional write, closing the concurrency
gap in §6):

| From | To | Trigger |
|---|---|---|
| `pending` | `downloading` | A worker picks up the job (automatic, first attempt) |
| `downloading` | `downloaded` | Real success |
| `downloading` | `retry_scheduled` | A classified-retryable failure, attempts remaining |
| `downloading` | `failed` | A classified-retryable failure, attempts exhausted; or a classified-non-retryable failure |
| `downloading` | `unavailable` | 404/410 (unchanged from today) |
| `retry_scheduled` | `downloading` | The next automatic attempt fires, or a manual retry is triggered |
| `failed` | `downloading` | **Only** a manual retry (never automatic — attempts are exhausted) |
| `unavailable` | *(none)* | Terminal, no transition out — the source content is gone, retrying cannot help |

---

## 3. Retry policy

- **Maximum attempts**: 3 total (1 initial + 2 retries), matching the
  queue's already-configured `attempts: 3` — a number this codebase
  already decided was reasonable, reused rather than re-litigated.
  Environment-configurable (`MEDIA_DOWNLOAD_MAX_ATTEMPTS`, matching this
  codebase's established `envInt(...)` convention), not hardcoded.
- **Backoff**: exponential, matching the queue's already-configured
  `{type: 'exponential', delay: 1000}` (1s, 2s, 4s) as the *default* —
  but see the required correction in §5: this can only take effect once
  the handler actually throws on retryable failures. Once active, this
  existing configuration does not need to change; it was never the
  problem.
- **Automatic vs. manual**: both, with the state machine's own
  transition table as the boundary. `retry_scheduled → downloading` can
  happen automatically (attempts remain) *or* manually (a user forces an
  earlier retry than the backoff would). `failed → downloading` can
  **only** happen manually — the directive's own instruction that manual
  retry is a distinct action, not merely "try again."
- **Retryable vs. terminal, by classified error** — this is the
  concrete taxonomy item 5 of the required scope, resolved from the
  real branches `processMediaDownload` already computes:

| Condition (already computed today) | Proposed classification |
|---|---|
| 404/410 from Baileys' download call | **Terminal** (`unavailable`) — unchanged, already correct |
| Empty buffer returned | **Retryable** — plausible transient CDN/network hiccup |
| Buffer exceeds `MEDIA_MAX_DOWNLOAD_BYTES` | **Terminal** — the object will not become smaller on retry |
| Checksum mismatch against sender-declared SHA-256 | **Retryable, but capped at 1 retry specifically** — could be transient corruption in transit, but a *repeated* mismatch strongly suggests a real integrity problem worth surfacing distinctly, not silently retried to exhaustion like a network blip |
| Any other thrown error (network timeout, DNS failure, Baileys internal error) | **Retryable** |
| A thrown error that is not HTTP-shaped at all (a genuine programming error - e.g. `decodeBuffersFromQueue` throwing on a malformed descriptor) | **Terminal, immediately** — retrying a bug is not a capacity strategy; this must fail closed to `failed` on attempt 1, never consume retry budget pretending it might succeed differently |

---

## 4. Idempotency

Answering each required sub-question directly:

- **How repeated jobs identify the same media operation**: `mediaId`
  is already the natural key (one `whatsapp_media` row per download
  target), but **BullMQ itself has no deduplication today** —
  `enqueueMediaDownload` calls `.add('media-download', data)` with no
  `jobId` option, so two enqueue calls for the same `mediaId` currently
  produce two independent BullMQ jobs with no relationship to each
  other. **Proposed**: pass a deterministic `jobId:
  \`media-download:${mediaId}\`` on every enqueue (both the original
  automatic enqueue and any future manual-retry enqueue). BullMQ's own
  documented behavior for a duplicate `jobId` is to reject the second
  add while the first is still active/waiting — this is a real,
  low-effort primitive that prevents "two jobs for the same media in
  flight simultaneously" at the queue layer, before either one even
  starts executing, rather than trying to detect the collision inside
  the handler.
- **Protection against duplicate downloads**: the deterministic
  `jobId` (above) prevents two *jobs* from running concurrently. Within
  a single execution, `storeMedia`'s existing sha256-keyed dedup (§7)
  already prevents writing the same bytes twice even if a download did
  happen twice for some reason (e.g. a manual retry racing a
  just-finishing automatic one, if the `jobId` guard were ever bypassed)
  — this existing protection is correct and stays exactly as-is.
- **Protection against duplicate database records**: not a real risk
  today or in this proposal — `whatsapp_media.insert` (job/row creation)
  happens exactly once, at ingestion time, before any download is ever
  attempted; retries only ever `UPDATE` that one existing row by `id`,
  never `INSERT` a new one. Guarded by the state-machine's `WHERE
  download_status = <expected>` transitions (§2), a retry can only ever
  update the one row it targets.
- **Safe behavior if a worker crashes after downloading but before
  recording completion**: today, this leaves the row permanently stuck
  in `'downloading'` (the "record failure" step never ran) — no
  code path detects or recovers this. **Proposed**: a scheduled sweep
  (mirroring this codebase's own established pattern — the
  `*-timeout-sweep` jobs already registered via
  `realtimeEventsQueue.upsertJobScheduler` for calls/sync-jobs/outbound-
  messages/emails/funnel-instances) that finds rows stuck in
  `'downloading'` past a real timeout (e.g. `updated_at < now() -
  interval '5 minutes'`) and transitions them to `retry_scheduled` (if
  attempts remain) or `failed` (if exhausted) — the exact same
  "reconcile a state a crash could have interrupted" pattern this
  codebase already uses five times elsewhere, not a new architecture.
- **Safe behavior if the same job is delivered twice** (BullMQ's own
  at-least-once delivery guarantee, independent of any bug): the guarded
  state transitions (§2) make this safe by construction — a second
  delivery of a job that already completed finds the row is no longer
  in the state the transition's `WHERE` clause expects (e.g. already
  `'downloaded'`, or already `'failed'` from the first delivery's
  outcome), so the guarded `UPDATE` affects zero rows and the handler
  can detect this (via the driver's row-count) and return without
  re-downloading or re-recording anything.

---

## 5. Why `attempts: 3` currently has no effect, and the proposed mechanism

Restated precisely from §1: BullMQ's `attempts`/`backoff` only govern
what happens when a job handler's promise **rejects**.
`processMediaDownload` catches every failure internally and always
resolves. This is not a bug in BullMQ or in the queue configuration —
it is a deliberate design in the original media pipeline (per its own
comment: computing one real outcome and reacting to it exactly once,
rather than duplicating failure-handling across early-return branches),
which had the side effect of making the job always "succeed" from
BullMQ's point of view.

**Proposed mechanism**: the handler should **throw** when the
classified outcome is `retry_scheduled`-bound (a retryable failure with
attempts remaining), so BullMQ's own `attempts`/`backoff` machinery
actually drives the automatic-retry timing — reusing existing,
already-configured infrastructure rather than building a parallel
scheduling mechanism. It should **not** throw when the outcome is a
terminal state (`downloaded`, `failed`-exhausted, `failed`-non-retryable,
or `unavailable`) — those are real, final outcomes the job correctly
recorded, and re-throwing would cause BullMQ to retry a job that has
nothing left to retry (once the DB row itself is already `failed`,
letting BullMQ attempt again would just repeat the same doomed download
against a row the state guard would then reject anyway). Concretely:
the DB write (row state transition) always happens first and is always
the source of truth; the decision to throw or return is a thin layer on
top of that already-computed outcome, not a separate judgment.

This directly answers the required question: **BullMQ's existing
mechanism can be safely activated, but only for the specific subset of
outcomes classified retryable in §3, and only after the state-machine
guard (§2) exists** — a bare "make it throw on every failure" change
without the state machine first would just reintroduce duplicate/racy
writes (§6) using the newly-active retry mechanism instead of preventing
them.

---

## 6. Concurrency

- **Multiple workers processing the same media**: within one process,
  `realtimeEventsWorker`'s `concurrency: 5` means up to 5 jobs run
  in parallel threads-of-control (Node's event loop, not OS threads) —
  today, nothing prevents two of those five from being for the *same*
  `mediaId` if two duplicate jobs were ever enqueued. The deterministic
  `jobId` (§4) closes this at the queue layer for genuinely duplicate
  enqueues; the guarded state transitions (§2) close it as a second,
  independent layer even if two *different* jobs somehow both targeted
  the same media (defense in depth, matching this engagement's
  consistent discipline of not relying on one single guard).
- **BullMQ's own per-job lock**: separately, BullMQ already provides a
  lock-per-job-instance mechanism (a Redis lock with a renewal
  heartbeat) that prevents the *same* job from being picked up by two
  different worker processes if this were ever scaled horizontally to
  multiple worker processes — this is existing BullMQ behavior this
  proposal does not need to add, only rely on.
- **Manual retry racing an automatic retry**: this is the concrete
  scenario the deterministic `jobId` + guarded transition combination is
  specifically designed for. If an automatic retry is already
  `'downloading'` when a user clicks manual retry, the manual retry's
  enqueue attempt with the same `jobId` is rejected by BullMQ (the
  automatic one is still active), so the user's action becomes a no-op
  rather than a race — this should surface to the user as "already
  retrying," not silently fail (an API/UI concern, §9).
- **Restart/recovery**: covered by §4's stuck-in-`'downloading'` sweep -
  a worker process restart mid-download leaves a row in `'downloading'`
  with no job to eventually complete it (the in-memory BullMQ lock is
  gone with the process); the sweep is what notices and recovers this,
  not a special-cased "on worker startup" check (simpler, and consistent
  with how this codebase already recovers from crashes elsewhere -
  scheduled reconciliation, not startup hooks).
- **Locking/unique constraints, actually needed**: no new unique
  constraint is needed — `whatsapp_media.id` is already the unique key
  every operation targets, and the guarded `UPDATE ... WHERE
  download_status = <expected>` *is* the concurrency-safety mechanism
  (a standard optimistic-concurrency pattern via the state column
  itself, not a separate lock table or advisory lock — proportionate to
  the actual risk, unlike Writing Twin's cap-enforcement problem in W3,
  which genuinely needed an advisory lock because it was preventing a
  *count* from being exceeded, a fundamentally different race than a
  single row's state transition).

---

## 7. Storage lifecycle

- **Partially downloaded files**: `storeMedia`'s `writeFile(filePath,
  JSON.stringify(envelope), { mode: 0o600 })` is **not atomic** — a
  process crash or unhandled exception mid-write can leave a truncated,
  corrupt file at the final path. Confirmed by direct reading of
  `localEncryptedMediaStorage.ts` (§1 audit, not assumed): there is no
  temp-file-then-rename pattern, and the file is written directly to its
  final, content-addressed location.
- **The dedup check does not validate content**: `fileExists(filePath)`
  (a plain `access()` check) returns `true` for a corrupt partial file
  exactly as readily as a genuinely complete one — meaning a crash-
  corrupted cache entry is **permanently unrecoverable by any future
  retry**, since every subsequent attempt's dedup check will find the
  (corrupt) file "already there" and skip writing entirely, then report
  `'downloaded'` success. This is a real, previously-undocumented defect
  this audit surfaces, distinct from the queue-retry problem but in the
  same subsystem.
- **Proposed fix** (Phase 2B scope, not decided here): write to a
  temporary path (`${filePath}.tmp-${randomSuffix}`) and atomically
  `rename()` to the final path only after a complete, successful write
  — the standard fix for exactly this class of bug, and a small,
  contained change to one function.
- **Whether failed artifacts are retained or removed**: today, a
  `'failed'`/`'unavailable'` outcome never calls `storeMedia` at all (it
  only runs on the success branch) — so there is no failed-download
  artifact to clean up on the `'failed'`/`'unavailable'` path itself;
  the only orphan risk is the atomicity bug above, on the success path.
- **Preventing orphaned objects**: with the atomic-rename fix, an
  interrupted write leaves only a `.tmp-*` file, never a corrupted
  `.enc` file masquerading as valid content. A best-effort startup or
  scheduled cleanup of stale `.tmp-*` files (age-based) is a reasonable
  addition, but is a small addendum to the atomic-write fix, not a
  separate mechanism.
- **Encryption/storage requirements**: unchanged — `storeMedia` already
  encrypts at rest via the proven `EncryptionService.encryptBuffer`
  pattern; nothing about retry changes this.

---

## 8. Observability

Proposed new columns on `whatsapp_media` (Phase 2B's migration, not
created here):

```
download_attempts       INTEGER NOT NULL DEFAULT 0
last_attempted_at       TIMESTAMPTZ
last_error_category     TEXT  -- e.g. 'network', 'checksum_mismatch', 'oversized', 'expired', 'internal'
last_error_message      TEXT  -- a short, sanitized message - never a raw stack trace or a full URL with tokens
next_retry_at           TIMESTAMPTZ  -- null once terminal
terminal_reason         TEXT  -- set only when download_status transitions to 'failed' or 'unavailable'
```

- **Logging discipline**: matching this codebase's existing
  `console.error` conventions in `processMediaDownload` (which already
  logs `mediaId` and a message, never the actual media bytes, the
  decoded Baileys descriptor, or an access-token-bearing CDN URL in
  full) — the new `last_error_message` column follows the identical
  discipline: a classified, short reason, never the raw error object or
  a URL with query-string credentials.
- **`last_error_category`** is what §3's retryable/terminal taxonomy
  becomes queryable data, not just in-code branching — useful both for
  the manual-retry UI (§9, "why did this fail") and for a future
  operator-facing dashboard, without over-building one now.

---

## 9. Manual retry surface — proposal only, per the explicit instruction

**Whether an API/UI control is actually needed**: yes — Phase 0 already
established that failed media is a real, user-visible dead end on both
surfaces (chat thread, status panel) with no recovery path today. This
proposal recommends building one, but the concrete route/UI shape below
is a *proposal*, not an implementation, and remains subject to a
separate approval per the directive's own instruction.

- **Proposed route**: `POST /api/workspace/media/:id/retry`, gated by
  the same `requireWorkspaceContext` + tenant-scoped lookup convention
  every other media-adjacent route already uses (`findByIdForBusiness`,
  never a bare `findById`) — no new authorization concept, reusing the
  existing pattern exactly.
- **Whether manual retry creates a new job or resets existing state**:
  **resets existing state, does not create a new database row** —
  consistent with §2's `failed → downloading` transition and §4's
  idempotency design. It *does* enqueue a new BullMQ job (there's no
  job left to resume — the prior one already completed, terminally), but
  with the same deterministic `jobId` convention, so if an automatic
  retry is somehow still in flight, the manual attempt is safely
  rejected at the queue layer rather than racing it.
  - The route only permits this transition from `failed` (an exhausted
    or non-retryable terminal state) — not from `retry_scheduled`
    (already going to retry automatically soon) or `downloaded`
    (nothing to do) or `unavailable` (retrying cannot help; the content
    is gone). This mapping is enforced by the same guarded-transition
    mechanism as every other state change, not a separate check.
- **Rate limiting**: a manual retry endpoint should reuse this
  codebase's existing `express-rate-limit` dependency (already a
  project dependency, unused for anything media-specific yet) rather
  than hand-rolling a click-debounce mechanism — proposed, not decided.

---

## 10. Regression test plan

All ten required cases, plus the two additional ones this audit's own
findings surfaced (storage atomicity, observability), for Phase 2B:

1. First attempt succeeds — `downloaded`, one `download_attempts`
   increment, `storeMedia` called once.
2. A retryable failure (simulated network error) transitions to
   `retry_scheduled`, then a subsequent automatic attempt succeeds.
3. Maximum attempts reached on a persistently retryable failure —
   final state is `failed`, `terminal_reason` set, no further automatic
   attempts occur.
4. A non-retryable error (oversized buffer, or a 404/410) goes straight
   to its terminal state (`failed` or `unavailable` respectively) on the
   **first** attempt, never consuming retry budget.
5. Worker crash mid-download (simulated by killing the job before
   `setDownloadResult`) — the row is left `'downloading'`; the sweep
   (§4) recovers it to `retry_scheduled` or `failed` after the timeout.
6. A duplicate job delivery (BullMQ's own at-least-once semantics,
   simulated by processing the same job data twice) — the second
   delivery's guarded transition affects zero rows; no double-download,
   no double-write.
7. Concurrent processing: two simultaneous enqueue attempts for the same
   `mediaId` — the deterministic `jobId` causes the second `.add()` to
   be rejected/no-op; only one real download occurs.
8. Download succeeds but persistence (`setDownloadResult`) fails
   (simulated DB error) — the real bytes are already stored (`storeMedia`
   already ran); the row remains `'downloading'`, correctly picked up
   by the crash-recovery sweep rather than being lost.
9. Persistence succeeds but job acknowledgment fails (BullMQ redelivers
   after a successful DB write) — case 6's guard applies identically;
   the redelivered job finds the row already `'downloaded'` and no-ops.
10. No duplicate media records/files — a full round trip (initial
    failure → automatic retry → success, and separately, a manual retry
    after exhaustion → success) asserts exactly one `whatsapp_media` row
    and exactly one physical file on disk throughout.
11. *(Additional, from §7's finding)* A simulated write interruption
    (killing the process between the temp-file write and the rename)
    leaves only a `.tmp-*` artifact, never a corrupt `.enc` file; a
    subsequent retry succeeds cleanly rather than being blocked by a
    poisoned dedup entry.
12. *(Additional, from §8)* `last_error_category`/`last_error_message`
    are populated correctly per the retryable/terminal taxonomy in §3,
    and never contain the raw media bytes, the full CDN URL, or a stack
    trace.

Cross-tenant isolation (this engagement's standing requirement,
independent of the directive's own list): a manual retry request for a
real `mediaId` belonging to another business is rejected identically to
a nonexistent id, via the same `findByIdForBusiness` convention every
other tenant-scoped route already uses.

---

## Summary: what Phase 2B would actually touch

- **Migration**: `whatsapp_media` gains `retry_scheduled` to its
  `download_status` CHECK (narrow-then-widen, this codebase's
  established convention) plus the six observability columns in §8. No
  other table changes.
- **`processMediaDownload`**: gains the retryable/terminal classification
  (§3), throws only on retryable-with-attempts-remaining outcomes (§5),
  and every DB write becomes a guarded transition (§2).
- **`localEncryptedMediaStorage.ts`**: `storeMedia` gains atomic
  temp-write-then-rename (§7) — a self-contained fix to one function.
- **`enqueueMediaDownload`**: gains a deterministic `jobId` (§4).
- **New**: a crash-recovery sweep (mirroring the existing five
  `*-timeout-sweep` jobs, §4) and, pending separate approval per §9, a
  manual-retry route + minimal UI control on both `ChatThread.tsx` and
  `StatusesPanel.tsx`.
- **Explicitly untouched, confirmed by this audit**: the WhatsApp
  connection/pairing/QR system, message ingestion classification, AI
  agent behavior, and everything from Phase 1 (this proposal builds on
  Phase 1's `whatsappStatusPersistenceService.ts` only by virtue of it
  calling the same media-download enqueue path status media already
  used — no change to Phase 1's own code is proposed or required).

No code, schema, or configuration changes were made in this phase.
Awaiting explicit approval of this proposal before Phase 2B begins.
