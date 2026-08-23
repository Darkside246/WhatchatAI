# Phase 0: Master Architecture, Security, Reliability Audit

**Status: read-only audit. No code, schema, or configuration changes in
this phase.** Every claim below is traced to a specific file/line in the
live repository (branch `openclaw-cell-runtime`, clean working tree at
commit `ab0f365`), not assumed from prior documentation. Where a claim
cannot be verified from the repository alone (e.g. external provider
account state), it is marked **UNVERIFIED** rather than guessed.

---

## Repository state

```
git status: clean, no staged/unstaged/untracked changes
branch: openclaw-cell-runtime (up to date with origin)
HEAD: ab0f365 "Phase W3: Personal AI Writing Twin implementation"
migrations: 69 files, latest 069_writing_twin.sql
test files: 103
```

Nothing unrelated is in flight. Safe to proceed to a scoped Phase 1 once
this report is approved.

---

## A. WhatsApp

### A1-A4: Text status root cause (the reported bug), evidence-traced

**The write path for a live-arriving text status is correct.** Traced
end-to-end:

1. `whatsappConnectionService.ts:316-327` (`messages.upsert` handler):
   classifies every upserted message via
   `whatsappMessageIngestionService.ingestUpsert`, then splits
   `remoteJid === 'status@broadcast'` messages into `enqueueStatusUpdates`
   - correctly separate from ordinary chat messages.
2. `whatsappMessageIngestionService.ts:142-147` (`classifyContent`):
   both a bare `conversation` and an `extendedTextMessage` (which is what
   a WhatsApp Status text post actually is under the hood) map to
   `contentType: 'text'` with `textPreview` populated - correct
   classification.
3. `incomingMessagesWorker.ts:411-425` (`processStatusUpdate`): inserts
   `text_content: ingested.textPreview`, `status_type:
   mapContentTypeToStatusType(ingested.contentType)` into
   `whatsapp_statuses` - correct persistence.
4. `whatsappStatusRepository.ts` (`insert`/`listByAccount`): both
   `status_type` and `text_content` round-trip correctly, no filtering
   that would exclude text-type rows.
5. `workspaceService.ts:490-500` (`listStatuses`): passes `statusType`
   and `textContent` straight through into the API response.
6. `StatusesPanel.tsx:19-26` (`StatusMedia`): `status.statusType ===
   'text'` already renders `status.textContent` in a dedicated text card
   (`<Type />` icon, not a broken media card) - **the frontend already
   handles this case correctly.**

**The actual defect is in a separate ingestion path that never reaches
any of the above.** `whatsappSyncService.ts:227-251`
(`ingestHistoryMessages`, called from `ingestHistorySet` at line 268,
which handles Baileys' `messaging-history.set` event - the event that
delivers a business's already-active WhatsApp Statuses at pairing time,
not live push-per-status) classifies messages with the same
`whatsappMessageIngestionService.ingestUpsert`, but then calls
`whatsappMessagePersistenceService.persist(...)` **unconditionally for
every message, including `status@broadcast` ones** - it has no
`remoteJid === STATUS_BROADCAST_JID` split, unlike the live
`messages.upsert` handler. `classifyJid('status@broadcast')` returns
`'broadcast'` (`jid.ts:7`), a value the `whatsapp_chats`/
`whatsapp_contacts` `jid_kind`/`chat_type` CHECK constraints explicitly
permit (`006_create_whatsapp_chats.sql:8,10`) - so this does **not**
throw. Instead, every status a business already had active at connection
time is silently misfiled as an ordinary message inside a phantom
`status@broadcast` "chat," and **never reaches `whatsapp_statuses` at
all.**

**Direct answer to the diagnostic questions**:
- Text status text: **received, but persisted through the wrong table
  entirely for historically-synced statuses** - not merely "not exposed"
  or "not rendered." A status posted live *after* the app is already
  connected works correctly end-to-end; a status that already existed
  at pairing time (the common real-world case a tester would actually
  observe) never appears, ever, because it never reaches
  `whatsapp_statuses`.
- Media statuses have the identical defect, for the same reason - this
  is not text-specific, though text is the more visible symptom since an
  image/video status might be dismissed as "just not downloaded" while a
  missing text status has no plausible alternate explanation.
- This is a genuine architectural cause (a missing filter in one of two
  parallel ingestion paths), not a UI rendering issue, a schema gap, or
  a classification bug - confirmed by direct code inspection, not
  inferred.

### A5-A8: Media status handling / download failure / retry infrastructure

- `whatsapp_media.download_status` (`009_create_whatsapp_media.sql:21-22`)
  is `CHECK (... IN ('pending', 'downloading', 'downloaded', 'failed',
  'unavailable'))` - no `retry_scheduled`/`retrying` state exists.
- **No retry-tracking columns exist anywhere** - confirmed by a
  repository-wide search for `download_attempts`/`retry_count`/
  `last_attempt`/`next_retry`: zero matches in any migration.
- `processMediaDownload` (`incomingMessagesWorker.ts:325-374`) runs
  exactly once per job, computes a single terminal outcome
  (`'downloaded'`/`'failed'`/`'unavailable'`), and **always resolves
  normally - it never throws.** The queue it runs on
  (`realtimeEventsQueue.ts:62-64`) *does* have BullMQ-level
  `attempts: 3, backoff: { type: 'exponential', delay: 1000 }`
  configured, but **that configuration is dead for this job type**: BullMQ
  only retries a job that rejects/throws, and this handler's own
  try/catch swallows every real failure into a normal return. **There is
  no automatic retry today, at ~30 seconds or any other interval** -
  confirmed by the absence of any retry-scheduling code, any
  `setTimeout`/delayed-job call in this function, and any second
  `media-download` job enqueue on failure.
- **No manual retry route or UI control exists** - a repository-wide
  search for a retry/redownload API route (`server/index.ts`) and for a
  "Retry" control in the frontend media components both returned zero
  matches. A failed download today is a permanent, silent dead end from
  the user's perspective, with only a static "download failed" caption
  ever shown (`StatusesPanel.tsx:46-52`; the chat-thread media component
  was not separately re-verified this pass but shares the same
  `download_status` model and is presumed to share the same gap -
  **UNVERIFIED** without a direct read of that specific component).

This is a real, substantial Phase 2 scope: the state model, the
automatic-retry mechanism, and the manual-retry UI/API all need to be
built essentially from scratch - none of it exists today beyond the
terminal status column itself.

---

## B. AI

### B1-B9

- **Gemini invocation**: `geminiClient.ts` - one lazily-constructed
  `GoogleGenAI` client per process, shared by the Sentinel and
  `aiReplyService.ts`. `getGeminiClient()` returns `null` (never throws)
  when `GEMINI_API_KEY` is unset, and every caller already treats that as
  "unavailable."
- **Provider fallback**: yes, real and already built -
  `aiReplyService.ts`'s `tryGooseFallback` is invoked whenever Gemini is
  unconfigured, circuit-broken, or fails outright. This is a genuine,
  existing provider-abstraction precedent (`gooseService.ts`) to extend,
  not build from zero.
- **Critical gap in the fallback trigger**: `generateAiReply`'s outer
  `catch (error)` block (`aiReplyService.ts`, confirmed earlier this
  session) treats every thrown error identically - it records a circuit-
  breaker failure and calls `tryGooseFallback` regardless of error class.
  There is no distinction between a retryable condition (429, timeout,
  transient 5xx) and a non-retryable one (auth failure, malformed
  request, authorization violation). The one existing special case
  (a 400 `INVALID_ARGUMENT` retried once with a bare request) is
  unrelated to this distinction. **This directly contradicts the
  directive's "do not blindly fail over on authentication/authorization
  failures" requirement** - today, it does exactly that.
- **System prompts/personas**: stored server-side in `ai_agents`
  (`persona`, `tone`, `systemInstruction`, `businessContext`,
  `responseStyle` columns), assembled by `buildSystemInstruction` - never
  sent as, or extracted from, customer chat messages. Confirmed
  structurally sound.
- **429 handling**: no 429-specific branch exists anywhere in
  `aiReplyService.ts` - a 429 is caught by the generic error handler
  above and treated exactly like any other failure (circuit-breaker
  failure + Goose fallback, or "unavailable" if Goose isn't configured).
  Functionally survivable (the circuit breaker will eventually open and
  stop hammering a rate-limited endpoint), but not a deliberate,
  quota-aware strategy - it's a side effect of generic failure handling.
- **Network failures**: same generic path as above - survivable, not
  differentiated.
- **Rapid-message AI-request amplification**: **confirmed, no
  protection exists.** `incomingMessagesWorker.ts`'s `processJob`
  computes `needsAiHandoff` per individual persisted message
  (`result.message.wasInserted && ... && Boolean(result.message.textContent)`)
  and calls `runAiHandoff` immediately, once per message. A repository-
  wide search for `debounce`/`Debounce` in this file returns zero
  matches. Four messages five seconds apart today produce four separate
  Gemini calls and four separate outbound replies - exactly the failure
  mode the directive describes.
- **AI configuration server-side**: yes, confirmed above (`ai_agents`
  table + `EntitlementService`/`AiAgentRepository`), not client- or
  chat-driven.

### B: Gemini rate-limit/quota configuration

**UNVERIFIED - cannot be determined from the repository alone.** The
codebase has no hardcoded RPM assumption to audit (good - it doesn't
pretend to know the plan), but it also has no proactive rate-limiting
logic keyed to a configured quota; the only throttle is the circuit
breaker's reactive `failureThreshold`/`cooldownMs`
(`aiCircuitBreaker.ts`, env-overridable, defaults 3 failures / 60s
cooldown). The actual Google Cloud project's billing status, tier, and
per-model RPM limit are external account facts this audit cannot read -
per the directive's own instruction, this is explicitly flagged as
requiring verification against the real provider account and current
documentation before any capacity claim is made, rather than assumed.

---

## C. Security architecture

Re-confirmed against live code (previously built and adversarially
tested across this engagement's own D1-D4/W1-W3 phases, not new
findings, but re-checked for currency):

- **`BusinessExecutionContext`** (`src/domain/businessExecutionContext.ts`):
  real, in place, three factory functions
  (`businessExecutionContextForUser`/`ForAiCell`/`ForSystem`), each
  deriving identity only from already-authenticated server-side state -
  confirmed unchanged since its introduction and its first real
  consumer (W3's `WritingTwinService`).
- **Tool Gateway / OpenClaw / `cellGeneration`**: `openclawToolGateway.ts`'s
  full authorization pipeline, `EntityOwnershipRegistry`/
  `LeadOwnershipResolver`, and the per-cell callback-secret + generation-
  counter mechanism (migration 195-era work) remain the authoritative,
  tested boundary for any AI-tool-initiated write - not re-derived here,
  since this entire mechanism was built and adversarially tested earlier
  in this same engagement and nothing in this audit touched it.
- **Repository-level tenant scoping**: the `findByIdForBusiness`
  convention is now applied across every repository this engagement has
  touched (WhatsApp media/chat/message, AI agent, team, business
  membership, notification, CRM contact, business documents, Writing
  Twin) - confirmed as the dominant, consistent pattern, not merely
  present in isolated spots.
- **Document/AI retrieval scoping**: D3-C's structural SQL-join
  boundary (`business_id`/`deleted_at`/`status`/`current_version_id`/
  `ai_retrievable` all enforced inside the query itself, never a
  post-fetch filter) remains the standard this audit found no
  regression against.
- **MCP boundaries**: OpenClaw's MCP surface was built with the same
  `BusinessExecutionContext`-derived authorization as the rest of the
  Tool Gateway - not independently re-verified this pass beyond
  confirming no new MCP-adjacent code has been added since.

No security regression was found in this pass. The security
architecture the directive describes as authoritative already matches
what exists.

---

## D. Product infrastructure

| Area | What exists | What's missing | Notes |
|---|---|---|---|
| **Email** | `email_messages`/`business_email_settings`, real draft→approve→send lifecycle, per-user `created_by`/`approved_by` FKs (W1-A's own audit) | Multi-recipient/attachment authorization policy beyond what W1-A found; no inbound email ingestion at all | Reuse existing draft/approval pattern for any AI-email work |
| **CRM identity** | `crm_contacts` 1:1 with a real WhatsApp contact identity (`crmContactRepository.ts:122`'s own comment); `resolveDisplayName` priority chain (verifiedName > businessName > displayName > pushName > phoneNumber) | No evidence of an Exact/Probable/Needs-Confirmation multi-signal matching system, or explicit device-contact-import identity tier, or explicit exclusion of the connected business's own number from contact import | **UNVERIFIED in depth** - the display-name resolution chain is real and traced, but the directive's fuller identity-resolution model (CRM verified > manually verified > imported device contact > WhatsApp display > phone) does not appear to exist as a distinct concept; would need a dedicated follow-up audit before Phase 11 work |
| **Billing** | Real `plans`/`plan_entitlements`/`subscriptions` schema (Phase 2C), `EntitlementService`'s count-limit enforcement pattern, a read-only billing UI page | **No payment-provider fee/tax/net-revenue calculation abstraction exists at all** - zero matches for any fee-rate concept anywhere in the codebase | This is a from-scratch Phase 7 build, not an extension - confirmed no BiMPay or any provider-fee logic exists to accidentally hardcode against |
| **Teams** | `teams`/`team_members`, roles (`OWNER`/`ADMIN`/`MANAGER`/`SUPERVISOR`/`AGENT`/`MARKETING`/`VIEWER` - more granular than the directive's proposed 5), chat assignment | **No invitation system exists at all** - zero files matching `*invit*`; membership is currently created directly, no pending/accepted/cancelled/expired/revoked flow | Phase 8's invitation lifecycle is new work, not an extension of an existing partial one |
| **Sessions** | Real, working revocation - `sessions.revoked_at`, `revoke()`/`revokeAllForUserExcept()` (`sessionRepository.ts:99-108`), enforced at the auth-middleware layer | Nothing found missing in this pass | Session security already matches the directive's requirement |
| **Timezone/locale** | `TimeProvider`/`TimeSyncService`/`TimeZoneResolver` (Phase built earlier this engagement) uses real IANA identifiers, UTC storage, no homemade offset table (confirmed by this engagement's own prior Phase 9-equivalent work) | Not re-audited for CLDR/ISO-country-code coverage specifically this pass | Already matches the directive's stated principle; treat as largely satisfied, confirm CLDR/country-code specifics only if a concrete gap surfaces |
| **Campaigns** | `campaigns.status CHECK (... IN ('DRAFT','REVIEW','APPROVED','SCHEDULED','RUNNING','COMPLETED','PAUSED','CANCELLED','FAILED'))` (`038_create_campaigns.sql:25-27`) | No `'ARCHIVED'` state; naming differs from the directive's proposed vocabulary (Active/Scheduled/Paused/Completed/Cancelled/Archived) | Terminology gap, not a defect - existing lifecycle is real and more granular (draft/review/approval already present) |
| **Funnels** | `funnel_instances.status CHECK (... IN ('ACTIVE','WAITING','COMPLETED','FAILED','CANCELLED'))` (`040_create_funnels.sql:49`) | No `'PAUSED'`/`'ARCHIVED'` state | Same class of terminology gap as campaigns |
| **Documents/Knowledge** | Full D1-D4 architecture: ownership → version → chunk, structural SQL-scoped retrieval (never fetch-then-filter), `ai_retrievable` capability flag, D4-B's context-gathering wiring | WhatsApp-channel Writing Twin learning (deliberately gated on a not-yet-built attribution migration, per W1-A/W5) | Already matches the directive's "retrieve WHERE ownership matches, never retrieve-then-filter" principle exactly - this is the one area of the whole directive already fully built to spec |
| **Audit logging** | `security_audit_logs` - real, durable, `eventId`/`businessId`/`eventType`/`severity`/`rawMetadata` shape, written from every sensitive mutation across this engagement's phases | No dedicated "Recent Activity" UI (15-item rolling window) found - **UNVERIFIED**, not searched this pass | The durable audit backend the directive wants already exists; the UI-window presentation layer on top of it was not confirmed present or absent this pass |

---

## Tests

103 test files exist. A dedicated `tenantIsolation.test.ts` exists, and
every phase across this entire engagement (Phase 0.1 through W3) added
its own inline cross-tenant/adversarial test cases directly into the
relevant feature's test file rather than centralizing them - confirmed
as the consistent, deliberate pattern (not a gap), matching this
engagement's own established testing discipline. WhatsApp classification/
call-timeout/status-routing tests exist (Phase from earlier in this
engagement). No dedicated AI-debounce, media-retry-state, or provider-
fallback-classification test suite exists yet, because none of that
functionality exists yet either - tests would be built alongside each
respective Phase 1-3 implementation, not retrofitted now.

---

## Summary: reusable architecture vs. genuine gaps

**Reusable as-is (extend, do not replace):**
- `BusinessExecutionContext` / Tool Gateway / OpenClaw authorization chain
- Repository-level `findByIdForBusiness` tenant-scoping convention
- Document/knowledge retrieval's structural SQL-scoped pattern
- `EncryptionService` field-encryption pattern
- BullMQ queue/worker infrastructure and its existing sweep-job convention
- `EntitlementService`'s count-limit enforcement pattern (directly reusable for Phase 7's usage limits)
- Email draft→approval→send lifecycle
- Session revocation
- TimeService/IANA timezone handling
- Gemini client + circuit breaker + Goose fallback (extend the fallback's trigger logic, don't rebuild it)

**Confirmed genuine gaps, evidence-based, requiring real new work:**
1. **WhatsApp status text/media**: `ingestHistoryMessages` needs a
   `remoteJid === STATUS_BROADCAST_JID` split identical to the live
   `messages.upsert` handler's own existing split - a small, precisely
   scoped fix now that the root cause is known (Phase 1).
2. **Media retry**: the entire state model (attempt tracking, scheduled
   retry, manual retry route + UI) needs to be built - none of it exists
   beyond the terminal status column (Phase 2).
3. **AI 429/fallback discrimination**: the fallback trigger needs to
   distinguish retryable from non-retryable errors - currently uniform
   (Phase 3).
4. **Inbound message debouncing**: does not exist at all - needs a
   bounded conversation-buffer mechanism keyed correctly to avoid
   cross-tenant/cross-chat bundling (Phase 3).
5. **Billing fee/tax abstraction**: does not exist at all - needs a
   provider-agnostic cost-model entity, not hardcoded fee assumptions
   (Phase 7).
6. **Team invitations**: does not exist at all - direct membership
   creation only today (Phase 8).
7. **CRM multi-signal identity resolution**: only partially audited;
   the directive's fuller model does not appear to exist - needs its
   own dedicated audit before implementation (Phase 11).

**Explicitly UNVERIFIED, requiring either external account access or a
follow-up targeted audit before any related implementation:**
- Actual Google Cloud/Gemini billing tier, RPM limit, and quota status.
- Whether the chat-thread (non-status) media component has an
  equivalent manual-retry gap to `StatusesPanel.tsx`'s confirmed one.
- Full depth of CRM contact-matching logic beyond the display-name
  resolution chain.
- Presence/absence of a "Recent Activity" 15-item rolling UI window.
- CLDR/ISO-country-code coverage specifics in the existing timezone/
  locale layer.

No code, schema, or configuration changes were made in this phase.
