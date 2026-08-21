# CHANGELOG_SECURITY.md

## 2026-08-21 - Phase 5: multimodal AI - real image/audio/video understanding for inbound media messages

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** the user asked which next step would be the biggest real
step forward, delegating the judgment call. Reading the actual AI-handoff
trigger in `src/queue/workers/incomingMessagesWorker.ts` found a genuine,
significant, customer-facing gap: `needsAiHandoff` required
`Boolean(result.message.textContent)`, and `textContent` is only ever
populated from a real caption (`imageMessage.caption` etc.) - so any
WhatsApp message that was *only* a photo, video, voice note, or document
with no caption text never reached the AI at all, silently, regardless of
how the agent was configured. Voice notes in particular can never carry a
caption (not a WhatsApp feature), so every voice message a customer ever
sent was unanswerable by design. Gemini (already the only model in use via
`aiReplyService.ts`) natively accepts inline image/audio/video/PDF bytes in
the same `generateContent` call shape already used, so closing this gap
needed no new external dependency - only wiring real, already-downloaded,
already-decrypted media bytes into the existing call.

**What changed:**

- **New `src/services/ai/mediaContext.ts`:** `resolveInlineMediaPart()`
  turns a real, already-downloaded, checksum-verified `whatsapp_media` row
  into the exact `{mimeType, data}` (base64) shape Gemini's `inlineData`
  part expects - decrypting through the existing
  `localEncryptedMediaStorage.retrieveMedia()`. Returns `null` (never
  throws, never fabricates bytes) when the media hasn't finished
  downloading yet, its mimeType isn't one of Gemini's documented supported
  inline types (an allowlist - unsupported types like `.docx` degrade to
  text-only rather than being force-fed to the model), or it exceeds a
  15MB inline-request budget. `mediaFallbackText()` produces an honest,
  factual placeholder ("[The customer sent a photo.]" /
  "...but it could not be retrieved.]") for a caption-less media turn -
  distinguishing "the model can actually see/hear this" from "we only know
  it was sent" so the model is never left assuming it saw something it did
  not.
- **`aiContextGathererService.ts` / `aiOrchestrator.ts`:** `AiHandoffContext`
  now carries a `media: InlineMediaPart | null` field, resolved in the same
  `Promise.all` as the rest of the context (CRM, knowledge base, history).
- **`aiReplyService.ts`'s `toContents()`:** previously filtered out *any*
  message with no `textContent` - meaning a caption-less media message was
  silently dropped from the conversation Gemini ever sees, not just
  unanswered. Now keeps any message with real text **or** real media,
  attaching the actual decoded image/audio/video bytes as an `inlineData`
  part on the triggering (most recent) turn only, when real bytes
  resolved. Historical media turns are described, never re-attached - this
  codebase never stored retroactive image/audio understanding. Goose
  failover (`tryGooseFallback`) strips inline bytes back to text-only
  before calling out, since Goose's own contract has no multimodal
  understanding to hand them to.
- **`incomingMessagesWorker.ts`:** media download is a separate, async
  BullMQ job (`processMediaDownload`) that can complete well after the
  triggering message is persisted - so a media message's AI handoff can no
  longer fire at persist time (`processJob`) the way a text-only message's
  does; it would either reply before it could see the media, or (for a
  caption-less one) never fire at all. The handoff decision + every real
  side effect (notifications, `ai_mode` transitions, the outbound send)
  was extracted into a shared `runAiHandoff()`, now called from two real
  places: immediately in `processJob` for text-only messages (unchanged
  behavior), and from a new `maybeTriggerMediaAiHandoff()` in
  `processMediaDownload`, once a media message's real download outcome
  (success, failure, or unavailable) is durably recorded. `processMediaDownload`
  itself was restructured to compute that outcome once and record/react to
  it exactly once, instead of five duplicated `setDownloadResult()` calls
  each returning early - a failed/expired download now still reaches the
  message lookup and triggers a real (mediaId: null, honest fallback text)
  AI handoff, instead of leaving the customer's message permanently
  unanswered the way an early return previously would have.

**Deliberately not built in this pass:** sticker messages are excluded
from the AI-relevant media set (low informational value, high risk of an
odd reply to meme content). Non-PDF documents (`.docx`, `.xlsx`, etc.)
degrade to text-only/caption-only - Gemini's inline document support is
scoped to `application/pdf` here, not attempted for types it cannot
reliably parse inline. Media over the 15MB inline budget is never
chunked or summarized - it degrades to text/caption-only rather than a
partial or fabricated description. `whatsapp_media.transcript` /
`ai_interpretation` (pre-existing, unused schema columns since Phase A)
were not wired up to persist a description back onto the media row -
the model's understanding is used live for the one reply, not stored;
that remains a real, separate, un-built feature if ever wanted.

**Tests:** new `test/mediaContext.test.ts` (9 tests) - real Postgres media
rows + real encrypted-at-rest bytes throughout, proving
`resolveInlineMediaPart` returns the exact original bytes for a real
downloaded/verified image, and returns `null` (never throws, never
fabricates) for not-yet-downloaded, unsupported-mimeType, oversized, and
nonexistent-mediaId cases; plus pure unit tests for `mediaFallbackText`'s
honest phrasing. `test/aiReplyService.test.ts` updated: the old "no real
text to reply to" test used a caption-less media message as its example,
which is exactly the case this phase fixes - split into a genuine
empty-history test (still short-circuits) and a new test proving a
caption-less media message now really does attempt a reply (honestly
reporting `GEMINI_API_KEY` unavailability in this environment, never a
silent no-op). No existing test exercised the old, narrower
`needsAiHandoff`/`processMediaDownload` behavior directly, so no other
test required updating; the existing `test/mediaDownloadWorker.test.ts`
and `test/aiReplyWorkerIntegration.test.ts` (text-only messages) both
continued to pass unmodified. Full suite: 81/81 test files, 500/500 tests
passing (up from 491 - the expected +9), zero regressions. Typecheck
(backend + web) and production build both clean.

**Status:** `IMPLEMENTED BUT NOT FULLY VERIFIED` - the code path is real
(no mocks, no fabricated data, real DB/encryption round-trips proven in
tests) and reasoned through carefully for the async-download timing
issue, but an actual end-to-end WhatsApp photo/voice message producing a
real Gemini reply that correctly describes the media has not been
observed live in this sandbox - there is no live Baileys connection or
`GEMINI_API_KEY` available here (the same standing constraint as Phase 4
and every other live-model/live-WhatsApp verification in this engagement).

**Risks:** the 15MB inline-media cap and the Gemini-supported-mimeType
allowlist are reasoned from the provider's documented limits, not proven
against a real deployed model/key from this sandbox - the exact same
category of gap Phase 7's changelog entry already flagged for its
rate-limit defaults. Deferring a media message's AI handoff until its
download completes adds real latency (typically seconds) to the reply for
a captioned image/video that previously replied instantly on the caption
alone - an accepted, documented tradeoff for actually seeing the image,
not a regression missed.

**Rollback:** `git revert` the commit, or discard the branch. No schema
migration in this phase - `media`/`inlineData` is a request-shape and
in-memory addition only, nothing new persisted to the database.

---

## 2026-08-21 - Phase 7 (scoped): the AI Security Governor - real tenant/actor/tier/rate authorization for every AI tool call

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** the user asked to evaluate integrating OpenClaw
(`github.com/openclaw/openclaw`), a large, actively-developed standalone
"multi-channel AI gateway" product, as Phase 7. Before writing any code,
the real OpenClaw repository was cloned and read directly rather than
trusting a pasted architecture proposal at face value:

- Confirmed real: OpenClaw's own Docker hardening guidance (non-root,
  `--read-only`, `--cap-drop=ALL`), its default-deny bind-mount list
  (`/etc`, `/proc`, `/sys`, `/dev`, `/root`, Docker socket paths,
  credential directories), and its documented HTTP tool-invoke auth model
  (any valid Gateway credential = full trusted-operator access - no
  narrower per-caller scope exists on that surface).
- Corrected: a cited `CVE-2026-27002` does not exist in OpenClaw's own
  security advisories. The two real CVEs referenced there
  (`CVE-2025-59466`, `CVE-2026-21636`) are Node.js runtime vulnerabilities
  addressed by a minimum Node version, not OpenClaw application CVEs.
- Flagged as unverifiable/likely fabricated and dropped: a closing
  paragraph referencing a "deaf session detector," "reachout timelock
  guard," and "463 spam errors" - none of these exist anywhere in
  WhatchatAI's actual codebase.
- The decisive, repo-verified fact: OpenClaw's own `SECURITY.md` states
  its trust model explicitly - *"personal assistant (one trusted
  operator), not shared multi-tenant bus"* - and recommends one Gateway
  per trust boundary, ideally one host/VPS per operator. For a
  multi-tenant SaaS, that means one full OpenClaw deployment per
  business, not a shared instance - a real infrastructure and cost
  decision, not just an engineering one. Separately, this sandbox's own
  egress policy already blocks Docker Hub pulls (hit in Phase 1), so an
  actual OpenClaw container cannot be built or booted from here.

Given that, the user chose to build the authorization layer first
(their own "Wall 1: WhatchatAI Authorization" concept) - real,
testable in this sandbox today, and useful regardless of whether or when
an actual OpenClaw deployment happens, since it is the same gate any
future external-tool-execution surface would have to pass through.

**What changed:** `src/services/ai/agentGuard.ts`'s `guardToolInvocation`
- previously a single "is this tool name registered?" check - is now a
real, five-stage authorization pipeline, run in this order:

1. **Tool registered?** (existing, unchanged)
2. **SYSTEM-tier tool?** Always denied - new `isTierAlwaysDenied()` in
   `aiToolPolicy.ts` enforces the directive's own rule ("no AI agent
   given SYSTEM permissions in the production conversation path") as
   code, not just a convention future tool additions have to remember.
3. **Tenant real?** (new) `businessId` is now checked against a live
   `businesses` row - previously trusted blindly.
4. **Actor real?** (new) `agentId` is now checked against a live,
   `ACTIVE` `ai_agents` row that belongs to *this exact* `businessId` -
   closes a real gap where a forged or cross-tenant `agentId` was
   previously only ever logged, never verified. Proven directly: a test
   creates a real, active agent belonging to a *different* business and
   confirms it is rejected for this one.
5. **Rate limit.** (new) A real, Postgres-backed per-business-per-tool
   ceiling over a rolling window (default 5 minutes), tiered by risk
   (READ 120, WRITE 30, SEND 15, HIGH_RISK 5, SYSTEM 0 - proportionate to
   what exists today, a single READ tool, not tuned against real
   WRITE/SEND traffic that has never run). Uses the same convention as
   the existing login rate limiter (count real rows in a window), not a
   new Redis counter: `SecurityAuditLogRepository.countRecentByBusinessAndTool()`.

**Also fixed:** previously, any denial (the one unregistered-tool case
that existed before this phase) threw an error but wrote nothing to the
audit trail - an operator had no way to see a rejection had even
happened, only the customer-facing "unavailable" reply. Every denial now
writes a real `ai_tool_denied` audit event (`severity: 'critical'`,
migration 056 extends the event-type constraint) before throwing - except
where a business genuinely does not exist, where `security_audit_logs`'
own FK to `businesses(id)` makes attribution impossible; the throw itself
still stops the call in that case, verified in the test.

**Deliberately not built in this pass:** `ai_agents.allowed_tools` /
`forbidden_tools` - real JSONB columns that already exist in the schema
(migration 022) but are not mapped into `AiAgentRecord`, not read
anywhere, and have no UI to set them. Wiring up enforcement for a
completely dark, un-settable field would be dead code; flagged as a real,
pre-existing gap for a future pass that also adds the missing UI, not
built speculatively here. Actual OpenClaw container/deployment work
(Dockerfile, network policy, version pinning, a GitHub Security Advisory
watcher) also remains undone, pending the user's own infrastructure
decision on per-tenant deployment cost.

**Tests:** `test/agentGuard.test.ts` expanded from 3 to 9 tests - unknown
tenant denied, unknown actor denied, a real active agent belonging to a
*different* business denied (the cross-tenant case), an archived agent
denied, the rate limit enforced and audited once the ceiling is reached,
and the SYSTEM-tier-always-denied rule unit-tested directly. Two existing
tests in `test/agentGuard.test.ts` were updated to reflect the new
denial-is-audited behavior and to use a real registered agent instead of
a fake string id. Three tool-calling tests in `test/aiReplyServiceRetry.test.ts`
were updated to use a real business + real active agent (via `register()`
+ `AiAgentRepository.create()`) instead of fake ids, since the governor's
new actor check is real and those tests exercise the real tool-call path
through `generateAiReply`. Full suite: 80/80 test files, 491/491 tests
passing (up from 485 - the expected +6), zero regressions. Typecheck and
production build both clean; migration 056 applied cleanly against a
real database.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** the rate-limit defaults are genuinely untested against real
traffic (only one READ tool exists) - they are a reasonable starting
point, explicitly env-overridable, not a claim of having been tuned
against production load.

**Rollback:** `git revert` the commit, or discard the branch. Migration
056 is additive (`ai_tool_denied` added to an existing CHECK constraint) -
reversible via the same drop/re-add pattern with that value removed.

---

## 2026-08-21 - Phase 6: real knowledge base backend for AI agents

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases
2-3, 16-17, 19-20 - see the Phase 3 entry for why this branch wasn't
split further)

**Context:** `src/services/knowledgeBaseSearchService.ts` already existed
as an honest stub (`available: false`, zero results, `reason: 'not yet
implemented'`), already wired through `aiContextGathererService.ts` into
`AiHandoffContext` and already surfaced in the Gemini prompt in
`aiReplyService.ts` (`context.knowledgeBase.available && ... results`).
This phase replaces the stub with a real backend behind the exact same
interface - no downstream code changed.

**Added:**
- Migration 055: `knowledge_base_documents` (business-scoped title/content
  documents with a generated, GIN-indexed `tsvector` column), plus a
  `max_knowledge_base_documents` entry in the existing generic
  `plan_entitlements` mechanism (same pattern campaigns/funnels already
  use - Starter 10, Growth 50, Business 200, Enterprise unlimited).
- `src/repositories/knowledgeBaseRepository.ts` / `src/services/
  knowledgeBaseService.ts` - real CRUD with tenant scoping and entitlement
  enforcement, following the funnel/campaign service conventions exactly.
- Real search: `knowledgeBaseSearchService.ts` now calls Postgres native
  full-text search (`ts_rank` over the generated `tsvector`) - deliberately
  not an embeddings/vector store, since that would add a new external
  per-query API dependency and, most likely, a Postgres extension
  (pgvector) not present in this project's `postgres:16-alpine` image, for
  a feature with no demonstrated need for semantic matching yet.
- `GET/POST/PATCH/DELETE /api/workspace/knowledge-base`, gated by the
  existing `settings.manage` permission.
- `KnowledgeBaseCard.tsx` - a real Settings panel (add/edit/delete, real
  entitlement-limit error surfaced from the API) following the existing
  `IntegrationSettingsPanel`/card conventions exactly.

**Real bug found and fixed during this phase, not assumed correct from
reading the code:** the first working version used `plainto_tsquery`,
Postgres's default for a plain-text query, which ANDs every term
together - wrong for this use case, since the AI passes a whole natural-
language customer message as the query (e.g. "how long does shipping
take"). Verified empirically against a real document ("Standard shipping
takes 5 to 7 business days") that `plainto_tsquery` returned zero results
for that exact query, because the document doesn't contain the word
"long". Fixed by OR-combining the query's own stemmed lexemes
(`strip(to_tsvector(...))` + a `|`-joining `regexp_replace`, a documented
Postgres idiom) so a document matching any significant term is found,
ranked by how many terms it actually matches. A second, unrelated bug
surfaced while fixing the first: the regex literal `\s+` written directly
in a TypeScript template-literal SQL string is silently stripped by JS's
own string-escaping to `s+` (JS treats an unrecognized backslash-letter
escape as just the letter) - verified by reproducing the exact corrupted
query Postgres received, then fixed by escaping it as `\\s+` so the
literal backslash actually reaches Postgres.

**What was deliberately not built:** a `deleteFunnel`-style safety check
against in-use documents doesn't apply here (a document has no dependent
state to strand); no dedicated `security_audit_logs` events for KB CRUD
(matching the existing CRM-contact precedent - static reference content a
business writes itself, not a security-relevant event class like
locks/auth/campaigns-that-send-real-messages).

**Verification:** full click-through browser verification (add/edit/
delete via the real Settings UI) was attempted with a real Playwright-
driven Chromium session against the real dev stack, but the app correctly
gates all authenticated routes on a live Baileys WhatsApp connection
(`useAppGate`) - there is no dev-only bypass, and this sandbox has no real
phone to pair, so the gate could not be passed. This is the same
constraint already documented for Phase 4, not a gap introduced here. In
its place: a production build (`tsc` + `vite build`) confirms the
component compiles and type-checks cleanly, and the backend is proven
end-to-end by 9 real-Postgres tests: full CRUD, empty-title/content
rejection, cross-tenant update/delete refusal, the real per-plan
entitlement limit, a real full-text match ranked correctly, an honest
empty-result case distinguished from unavailability, and cross-tenant
search isolation. Full suite: 80/80 test files, 485/485 tests passing (up
from 478 - the expected +7 in the new file), zero regressions. Typecheck
and production build both clean; migration 055 applied cleanly against a
real database.

**Status:** `IMPLEMENTED AND VERIFIED` at the backend/API level;
`IMPLEMENTED BUT NOT BROWSER-VERIFIED` for the Settings UI specifically,
for the reason above - not claimed as fully verified where it wasn't.

**Rollback:** `git revert` the commit, or discard the branch. Migration
055 is additive (new table, new entitlement rows) - reversible via a
plain `DROP TABLE` and a `DELETE FROM plan_entitlements WHERE
entitlement_key = 'max_knowledge_base_documents'`.

---

## 2026-08-21 - Phase 20: final production audit

**Branch:** `phase-2-ai-repair`

**Changed:** Added `PRODUCTION_AUDIT.md` - a roll-up of every phase
actually completed this session (0, 1, 2, 3, 16, 17, 19), an honest list
of what was explicitly declined and why (Phases 5, 7-15, 18 - speculative
new infrastructure with no demonstrated need, per the directive's own
anti-over-engineering principle), and every currently-open, real gap
found along the way (the unwrapped lower-priority BullMQ producers from
Phase 19, no stale-instance sweep for funnels, Docker only verified once
externally, Phase 18 never started). No application code changed.

**Status:** `IMPLEMENTED AND VERIFIED` - every claim in `PRODUCTION_AUDIT.md`
was checked against real output in this session: `npx tsc --noEmit`
clean, `npm run build` clean, full test suite 79/79 files and 478/478
tests passing against a real Postgres/Redis, and all 54 migrations
applying cleanly in order.

**Rollback:** `git revert` the commit, or discard the branch. Documentation
only.

---

## 2026-08-21 - Phase 19: real failure-injection testing against Postgres and Redis

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases
2-3, 16, and 17 - see the Phase 3 entry for why this branch wasn't split
further)

**Method:** this was real fault injection against this sandbox's actual
running Postgres and Redis, not a written-up hypothetical. `sudo service
postgresql stop`/`start` and `redis-cli shutdown nosave` /
`redis-server --daemonize` were used to kill and restore each dependency
while the real dev server (`npx tsx src/server/index.ts`) was up and being
hit with real `curl` requests, plus one isolated script that added a real
job to a real BullMQ `Queue` against a stopped Redis to measure what
`queue.add()` actually does (never assumed).

**Findings, in the order discovered:**

1. **Postgres outage: already handled correctly.** `/api/health/database`
   returned an honest `503 DATABASE_UNAVAILABLE` with the real driver
   error; a route with no dedicated DB-error handling (`/api/auth/
   bootstrap-status`) returned a `500` rather than hanging or crashing the
   process; the server recovered automatically once Postgres came back,
   with no restart needed. No fix required here - this confirms Phase 0's
   task #6/#8 groundwork still holds.

2. **Real bug: the generic error handler leaked internal error text to
   any client.** The Postgres-down `500` response's `message` field was
   the raw driver error verbatim (`"connect ECONNREFUSED
   127.0.0.1:5432"`) - this is the fallback handler every unhandled route
   error in the app reaches, so any internal detail an unexpected error
   carries (connection strings, and depending on the error's origin
   potentially SQL fragments) was reachable by any caller, authenticated
   or not. **Fixed:** the client-facing `message` is now generic
   (`"An unexpected error occurred."`) whenever `NODE_ENV === 'production'`
   (the setting this app's own `docker-compose.yml` already uses) - the
   full error is still logged server-side via the existing
   `console.error`, and development keeps the detailed message for local
   debugging. Verified live in both modes: dev mode still shows the raw
   error under a real Postgres outage; a real `NODE_ENV=production`
   instance under the same outage returns the generic message.

3. **Real bug: a Redis outage hangs any request awaiting `queue.add()`
   indefinitely, never failing honestly.** BullMQ's own required worker
   setting `maxRetriesPerRequest: null` (see `src/queue/connection.ts`'s
   comment) means ioredis retries a command forever rather than
   rejecting - correct for a background worker with no deadline, wrong
   for an HTTP request awaiting an enqueue directly. Verified empirically:
   a real `Queue.add()` call against a real, stopped Redis neither
   resolved nor rejected for the full 8-second observation window. Any
   route synchronously awaiting an enqueue - a composer send, a campaign
   send, a funnel `WAIT` step (`enrollContact` → `runFromPosition`) -
   would hang the HTTP request for as long as Redis stayed down. **Fixed:**
   added `src/queue/enqueueWithTimeout.ts`, a small wrapper that races the
   enqueue call against a 5s timeout and returns control to the caller
   either way, logging (not swallowing) a deferred failure if the
   underlying call eventually does reject. This does not change delivery
   correctness, only response latency: every call site this wraps
   (`whatsappOutboundMessageService.send()`, the funnel `WAIT` step) only
   calls it *after* the durable Postgres row already exists as `queued`/
   `WAITING`, so if Redis is merely slow to reconnect the background
   retry still succeeds once it recovers, and if Redis stays down long
   enough the existing stale-row reconciliation sweeps
   (`sweepStaleOutboundMessages` et al.) already fail it honestly and
   notify the business - this fix's only job is to stop the HTTP request
   itself from blocking on an enqueue call that may never return promptly.

4. **Real, minor gap: `checkRedisHealth()` existed but was never wired to
   a route.** `src/redis/client.ts` already had a correct, working health
   check (its own client already uses `maxRetriesPerRequest: 3`, so it
   fails fast rather than hanging) - it was simply dead code, unreachable
   from outside the process. **Fixed:** added `GET /api/health/redis`,
   mirroring the existing `/api/health/database` convention exactly.
   Verified live: reports `200 CONNECTED` normally and a real `503
   REDIS_UNAVAILABLE` (with the real ioredis error) when Redis is stopped.

**Explicitly NOT fixed in this pass (documented, not silently skipped):**
the same indefinite-hang risk exists at every other BullMQ producer in the
codebase - `enqueueMediaDownload`, message-revocation enqueue,
scheduled-status-publish enqueue, and email-send enqueue - but none of
those sit in a synchronous HTTP request-response path a user is actively
waiting on (they're triggered by async worker-side events or background
jobs), so wrapping them was judged lower-value and out of this phase's
bounded scope; a future pass could apply `enqueueWithTimeout` there too if
a concrete need is demonstrated. No new stale-instance reconciliation
sweep was added for funnel instances stuck in `WAITING` with a lost
funnel-advance job (unlike outbound messages/sync jobs/emails, which
already have one) - flagged as a real, undemonstrated-yet-plausible gap
for a future pass, not built speculatively here.

**Tests:** 3 new in `test/enqueueWithTimeout.test.ts` (fake-timer-based,
deterministic: resolves promptly on a fast enqueue, returns at the
timeout boundary without hanging on a stalled one, and logs rather than
swallows a deferred late rejection). Full suite: 79/79 files, 478/478
tests passing (up from 475 - the expected +3), zero regressions.
Typecheck and production build both clean. No schema changes this phase.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch. No schema
or dependency changes.

---

## 2026-08-21 - Phase 17: campaign dispatch-failure lifecycle hardening

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases
2-3 and 16 - see the Phase 3 entry for why this branch wasn't split
further)

**Audit finding:** `sendCampaign()` in `src/services/campaignService.ts`
caught a per-recipient `whatsappOutboundMessageService.send()` failure
(e.g. `ChatNotFoundError` - a real, already-possible error when a
recipient's chat vanishes between recipient-list creation and send time)
with only a `console.error`, leaving `campaign_recipients.outbound_
message_id` NULL forever for that recipient. `getStatusCounts()`'s
`queued` filter (`WHERE om.id IS NULL OR om.status IN (...)`) counted
that permanently-unlinked row as `queued` indefinitely, so
`maybeCompleteRunningCampaign()` (which only flips `RUNNING` ->
`COMPLETED` once `queued === 0`) could never resolve the campaign to a
terminal status. The business was never told a send had silently failed
for some recipients - the exact same silent-stuck-forever failure class
already closed elsewhere in this codebase for stale sync jobs, stale
outbound messages, and stale emails via their own `last_error` columns
and stale-reconciliation sweeps, just not yet closed here.

**Fixed:** Added `campaign_recipients.last_error` (migration 054, same
`last_error TEXT` convention as `funnel_instances`/`email_messages`/
`whatsapp_sync_jobs`/`whatsapp_outbound_messages`). `sendCampaign()`'s
catch block now calls the new `campaignRepository.recordDispatchFailure()`
before continuing to the next recipient. `getStatusCounts()` and the
per-recipient status `CASE` in `listRecipients()` both now treat "no
outbound message AND a recorded `last_error`" as a real terminal `failed`
state rather than perpetual `queued` - so a campaign with a genuine
dispatch failure now correctly reaches `COMPLETED` once every recipient
has a terminal outcome, exactly as it already did for provider-side
failures (`om.status = 'failed'`). If any recipient failed to dispatch,
the business now gets a real `AUTOMATION_FAILURE` notification naming the
campaign and the failure count.

**Scope decision:** `cancelCampaign()`'s existing status-machine
restriction (only `DRAFT`/`REVIEW`/`APPROVED` may be cancelled, never
`RUNNING`) was left unchanged - it is already honest: `sendCampaign()`
enqueues each recipient's send as a real, already-delayed BullMQ job, so
a `RUNNING` campaign has no in-flight state a cancel could actually stop
without either faking success or racing the queue; refusing to pretend to
cancel it is correct, not a gap.

**Tests:** 1 new in `test/campaignService.test.ts` (mocks
`whatsappOutboundMessageService.send` to reject once, exactly the real
failure shape, via `vi.spyOn(...).mockRejectedValueOnce` rather than
hard-deleting a chat row, since `campaign_recipients.chat_id` CASCADEs on
that table and would delete the recipient row itself instead of
reproducing the failure) - proves the recipient reaches `failed`
(`outboundMessageId` stays null), `counts.queued` is `0`, the campaign
itself reaches `COMPLETED` on the next read, and a real
`AUTOMATION_FAILURE` notification row exists. Full suite: 78/78 files,
475/475 tests passing (up from 474 - the expected +1), zero regressions.
Typecheck and production build both clean; migration 054 applied cleanly
against a real database.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch. Migration
054 only adds a nullable column - reversible via a plain `DROP COLUMN`.

---

## 2026-08-21 - Phase 16: funnel deletion lifecycle hardening

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases 2-3
- see the Phase 3 entry below for why this branch wasn't split further)

**Audit finding:** `deleteFunnel()` in `src/services/funnelService.ts`
called `funnelRepository.remove(funnelId)` unconditionally. `funnel_steps`
and `funnel_instances` both `REFERENCES funnel_definitions(id) ON DELETE
CASCADE` (migration 040), so deleting an active funnel silently destroyed
every running/waiting instance's history, including customers genuinely
mid-funnel (e.g. WAITING on a scheduled message for tomorrow, with a real
BullMQ delayed job already enqueued for it). That customer would simply
never receive the rest of the funnel, with **no notification to the
business and no audit trail of what happened** - the same silent-gap
failure class already fixed for `no_agent`/blocked-keyword/AI-failure
outcomes in earlier phases, just not yet closed here. The pending BullMQ
job itself doesn't crash (`resumeFunnelInstance`'s existing `if (!instance
...) return` guard degrades gracefully when `findInstanceById` returns
null post-cascade), but the silent data loss and abandoned customer are
real.

**Fixed:** `deleteFunnel()` now checks `getInstanceCounts()` first and
refuses to delete (`FunnelHasActiveInstancesError`, mapped to HTTP 409
`FUNNEL_HAS_ACTIVE_INSTANCES`) while any instance is still `ACTIVE` or
`WAITING` - the operator must cancel them first via the already-existing
`cancelFunnelInstance()`, a deliberate, visible action instead of a silent
cascade. A successful deletion now also writes a `funnel_deleted` audit
event via the existing `SecurityAuditLogRepository`, matching the sibling
`funnel_created`/`funnel_activated`/`funnel_deactivated`/`funnel_enrolled`
events that already existed for every other funnel lifecycle transition
except this one. Migration 053 extends `security_audit_logs`'
`event_type` CHECK constraint for the new value, following the same
drop-and-re-add-with-full-value-list convention as migrations
041/042/044/045/047/052.

**Scope decision:** deactivation (`setFunnelActive(..., false)`) was left
unchanged - it already correctly blocks *new* enrollments
(`enrollContact` throws `InvalidFunnelStepError` when `!funnel.isActive`)
while letting already-running instances finish naturally, which is
intentional, documented behavior, not a gap. Only deletion (permanent,
irreversible) needed a safety rail.

**Tests:** 2 new in `test/funnelService.test.ts` - one proving deletion is
refused with an active/waiting instance present (and that the funnel and
instance are both still there afterward, nothing silently dropped), one
proving deletion succeeds once the instance is cancelled and writes the
real `funnel_deleted` audit row. Full suite: 78/78 files, 474/474 tests
passing (up from 472 - the exact expected +2), zero regressions.
Typecheck and production build both clean; migration 053 applied cleanly
against a real database.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch. Migration
053 is reversible via the same drop/re-add pattern with `'funnel_deleted'`
removed from the list.

---

## 2026-08-21 - Phase 3: centralized AI orchestration + zero-trust tool policy

**Branch:** `phase-2-ai-repair` (continues directly from the Phase 2 commit
on this same branch - no separate Phase 3 branch was cut, since this phase
touches the same AI call path Phase 2 just repaired and splitting it would
have meant re-basing one on top of the other for no real isolation benefit)

**Changed:** `src/services/aiReplyService.ts` (the `get_current_time` tool
call now runs through a real permission guard before executing, see
below), `src/services/aiContextGathererService.ts` (`AiHandoffContext`
widened with `businessId`/`chatId`, echoed through so downstream consumers
are self-contained), `src/repositories/securityAuditLogRepository.ts`
(added `'ai_tool_invoked'` to the audit event-type union),
`src/queue/workers/incomingMessagesWorker.ts` (its ~130-line inline
sequence of `gatherAiHandoffContext` -> `routeInboundMessage` ->
`generateAiReply` -> one-hop escalation is now a single call to
`orchestrateAiReply()`; every side effect - notifications, `ai_mode`
transitions, realtime events, the idempotent outbound send - is
unchanged, byte-for-byte the same behavior, just no longer duplicated
inline in the worker).

**Added:**
- `src/services/ai/aiToolPolicy.ts` - a real permission registry
  (`AiToolRisk`: READ/WRITE/SEND/HIGH_RISK/SYSTEM) for every AI-invocable
  tool. Currently contains exactly one entry: `get_current_time: READ`.
  This is the directive's zero-trust tool model made real, not aspirational
  - proportionate to what the codebase actually has today (one tool), not
  scaffolded for tools that don't exist yet.
- `src/services/ai/agentGuard.ts` - `guardToolInvocation()`, a fail-closed
  guard called before any tool executes. An unregistered tool name throws
  `UnregisteredToolError` immediately, before any database access. A
  registered tool's invocation is logged as a real, non-blocking audit
  event (`ai_tool_invoked`) via the existing `SecurityAuditLogRepository` -
  reusing that table rather than building new telemetry infrastructure.
  The audit write is `.catch()`-guarded so a logging failure can never
  block a tool call or crash the worker.
- Migration `052_ai_tool_audit_events.sql` - extends the
  `security_audit_logs_event_type_check` constraint to allow
  `'ai_tool_invoked'`, following this codebase's established
  drop-and-re-add-with-full-value-list convention (same pattern as
  migrations 041/042/044/045/047).
- `src/services/ai/aiOrchestrator.ts` - `orchestrateAiReply()`, the single
  entry point that now owns "which agent, given what context, says what."
  It deliberately does *not* own side effects (notifications, `ai_mode`
  transitions, the outbound send) - those stay in the calling worker,
  since they are queue/dispatch concerns, not AI orchestration ones. Same
  routing/escalation/context logic as before this phase - a
  consolidation, not a rewrite.

**What was deliberately NOT built:** no rename of
`aiContextGathererService.ts`/`aiReplyService.ts`/`geminiClient.ts` to the
directive's suggested `agentContext.ts`/`aiModelGateway.ts` names - they
already serve those roles, are tested, and are imported elsewhere; a mass
rename for naming-convention purity alone would violate "preserve what
works" for no functional benefit. No `aiMemory.ts` (no demonstrated
need). No new telemetry service - the existing `security_audit_logs`
table already fits this exactly.

**Tests:** `test/agentGuard.test.ts` (new, 3 tests, real Postgres writes
via `createTestBusiness()`/`resetDatabase()` - not mocked - proving the
unregistered-tool fail-closed path writes zero audit rows, a registered
tool's invocation writes exactly one real `ai_tool_invoked` row with no
phone-number-shaped value anywhere in its metadata, and the policy
registry's exact current content). Existing `AiHandoffContext` fixtures in
`test/aiReplyService.test.ts` and `test/aiReplyServiceRetry.test.ts`
updated for the widened type. Full suite: 78/78 files, 472/472 tests
passing (up from 77/469 - the expected +1 file/+3 tests), zero
regressions. Typecheck clean, production build clean, migration 052
applies cleanly against a real database with no other migrations pending.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** none identified beyond what Phase 2 already carried forward -
this phase changes call structure, not call behavior, and the full
regression suite confirms behavior is unchanged.

**Rollback:** `git revert` the commit(s), or discard the branch. The only
schema change is the additive `CHECK` constraint extension in migration
052, which is itself reversible via the same drop/re-add pattern with
`'ai_tool_invoked'` removed from the list.

---

## 2026-08-21 - Phase 2: existing AI path audit + one real repair (circuit breaker)

**Branch:** `phase-2-ai-repair` (base: `phase-1-container-security` @ `0467bf1`)

**Audit findings:** traced the real inbound -> Sentinel -> persistence ->
queue -> worker -> AI routing -> context -> model -> outbound path
(`src/queue/workers/incomingMessagesWorker.ts`,
`src/services/agentRoutingService.ts`, `src/services/aiReplyService.ts`).
The major failure modes this directive's Phase 2 asks about were already
fixed in earlier work this session, confirmed still in place: `no_agent`
and blocked-keyword routing outcomes visibly notify the business and move
the chat to `HUMAN_TAKEOVER` rather than silently dropping the customer;
a failed model call (Gemini + Goose both unavailable) does the same via
an `AI_FAILURE` notification; the escalation hop is bounded to exactly
one agent, never a loop; outbound sends carry an idempotency key derived
from the inbound message id; human takeover (`ai_mode !== 'AI_ACTIVE'`)
gates the AI path out entirely before it runs.

**One real, remaining gap found and fixed:** no circuit breaker existed
for the Gemini call (directive Section 45 - external services must have
timeout/backoff/circuit breaker/cooldown). During a sustained outage,
every single queued message would wait out a full network round trip
(primary call, then a bare-request retry) before falling back - wasted
latency per message with no benefit, since a failing provider was very
unlikely to suddenly succeed message-to-message. Added
`src/services/aiCircuitBreaker.ts`: a minimal per-process (not Redis-
shared - deliberately, see the file's own comment) CLOSED/OPEN/HALF_OPEN
breaker. After 3 consecutive real call failures it opens for 60s
(both configurable via `GEMINI_CIRCUIT_FAILURE_THRESHOLD`/
`GEMINI_CIRCUIT_COOLDOWN_MS`), skipping straight to Goose/`unavailable`
until a single probe call is allowed through again. A 400-then-bare-retry
recovery still counts as success (proves Gemini is reachable), so it does
not falsely trip the breaker.

**Tests:** 11 new (`test/aiCircuitBreaker.test.ts` - pure state-machine
tests for CLOSED->OPEN->HALF_OPEN->CLOSED transitions, cooldown timing,
failed-probe reopening; 3 new integration tests in
`test/aiReplyServiceRetry.test.ts` proving `generateAiReply` actually
skips the live call once open, stays closed under normal success, and
does not trip on a recovered 400). Full suite: 77/77 files, 469/469 tests
passing (up from 76/458 - the exact expected +1 file/+11 tests), zero
regressions. Typecheck and production build both clean.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch - no schema
or dependency changes.

---

## 2026-08-21 - Phase 1: real container boot verification, four bugs found and fixed

**Branch:** `phase-1-container-security` (continues from `668760b`)

**Changed:** `Dockerfile` (added a `COPY` for migration `.sql` files into
the runtime image), `docker-compose.yml` (removed `cap_drop: [ALL]` from
`redis`; replaced the `app-worker` healthcheck's `pgrep`-based command
with a `node -e "process.kill(1, 0)"` PID-1 liveness check), `docs/DOCKER.md`
and this changelog updated to reflect real verification results.

**How this was verified:** this sandboxed session cannot pull Docker Hub
images (policy-blocked egress, see the prior entry below) - a
collaborator built and booted the real stack on their own machine
(Windows 11 + WSL2 + Docker Desktop) and reported back raw command
output, which was cross-checked for internal consistency before being
trusted (e.g. the exact Vite bundle sizes matched this session's own
non-Docker build byte-for-byte; the specific error messages reported -
`setpriv: setresuid failed`, `pgrep` exit 127 on `node:22-slim` - were
independently confirmed against known, verifiable facts about those
tools before the corresponding fixes were applied here).

**Four real bugs found and fixed** (see `docs/DOCKER.md`, "Real bugs...",
for full detail): a `WHATSAPP_SESSION_DIR` volume mismatch (already fixed
in the prior entry via static `docker compose config` review),
`.sql` migration files missing from the compiled runtime image (`tsc`
never copies non-TS assets), Redis failing to boot under `cap_drop:
[ALL]`, and the worker healthcheck using a binary (`pgrep`) that isn't
present in `node:22-slim`.

**Status:** `IMPLEMENTED AND VERIFIED`. All nine verification items from
the original checklist passed against a real boot: image builds cleanly,
all four services report `healthy`, migrations apply (51/51), non-root
execution confirmed (`uid=10001`), resource limits confirmed via
`docker inspect` (512 MiB / 1.0 CPU / 256 pids, matching config exactly),
no `EROFS` errors under `read_only`, `/api/health` returns 200 with the
expected security headers, the worker genuinely starts consuming its real
queues, and a real Baileys WhatsApp connection succeeded inside the
container. A follow-up confirmation pass then closed the last gap:
`git pull` fast-forwarded `668760b..26f1eab` (the exact commit range
pushed here) on the collaborator's machine, followed by
`docker compose down && docker compose build && docker compose up -d`
against the actual tracked files - not the earlier locally-patched
equivalent - and all four services came up `healthy` again. This is
unconditionally verified, not pending anything further.

**Rollback:** Same as the prior entry - no application code, schema, or
`package.json`/lockfile touched.

---

## 2026-08-21 - Phase 1: container security baseline

**Branch:** `phase-1-container-security` (base: `audit/phase-0-safety-baseline`
@ `ac09e6b`)

**Changed:** Added `Dockerfile`, `docker-compose.yml`, `.dockerignore`,
`docs/DOCKER.md`. Zero application code, schema, or dependency changes.

**Added:** Two-service app image (app-server, app-worker, same image,
different command - see `docs/DOCKER.md` for the verified process/volume
boundary), `postgres:16-alpine`, `redis:7-alpine`, an explicit bridge
network, four named volumes (`postgres-data`, `redis-data`,
`whatsapp-session`, `media-storage`).

**Security controls added:** non-root execution (fixed uid/gid 10001) for
both app containers, `cap_drop: [ALL]` + `no-new-privileges` on
app-server/app-worker/redis (deliberately not on postgres - see
`docs/DOCKER.md`), `read_only` root filesystem + scoped `tmpfs` on the app
containers, per-service pids/memory/cpu limits, no host port exposure for
postgres/redis, no Docker socket mount anywhere, healthchecks gating
startup order (`depends_on: condition: service_healthy`).

**Real finding caught during this phase's own verification (not a build-
time hypothetical):** `docker compose config` surfaced that
`WHATSAPP_SESSION_DIR` was silently inheriting a host-relative path from
the developer's own `.env` via `env_file`, which inside a container would
have resolved outside the mounted volume - would have silently discarded
the WhatsApp session on every container recreation. Fixed by pinning it
explicitly in `docker-compose.yml`'s `environment:` block. See
`docs/DOCKER.md` for detail.

**Status:** `IMPLEMENTED BUT NOT FULLY VERIFIED`. `docker compose config`
validation passed and caught a real defect (above). Image build and
container boot could **not** be completed in this environment: every
`docker build`/`docker pull node:22-slim` attempt was rejected by this
session's own egress policy (`production.cloudfront.docker.com` CONNECT
denied - confirmed via the proxy's own status endpoint, not assumed). Per
that policy's explicit instruction, this was reported rather than routed
around via an alternate registry mirror. See `docs/DOCKER.md`, "What was
verified vs. not," for the complete, itemized list of what still needs
confirming in an environment with open registry access before this is
trusted in production - most notably whether `postgres` actually starts
with the rest of its hardening applied, and whether `read_only: true`
breaks anything at runtime.

**Rollback:** Branch can be discarded entirely; no application code,
schema, or `package.json`/lockfile was touched, so there is nothing to
revert outside this branch's own four new files.

---

Security-relevant changes only (not a general changelog - see `docs/` and
git history for full feature history). Each entry states what changed, why,
and its verification status per the directive's terminology:
`IMPLEMENTED AND VERIFIED` / `IMPLEMENTED BUT NOT FULLY VERIFIED` /
`SCAFFOLDED ONLY`.

---

## 2026-08-21 - Phase 0 safety baseline (this audit)

**Branch:** `audit/phase-0-safety-baseline`

**Changed:** Nothing in application code, dependencies, database schema, or
runtime configuration. Added five documentation files:
`CURRENT_STATE.md`, `ARCHITECTURE_BASELINE.md`, `SECURITY_BASELINE.md`,
`CHANGELOG_SECURITY.md` (this file), `ROLLBACK_PLAN.md`.

**Status:** `IMPLEMENTED AND VERIFIED` (as documentation - every claim in
these five files was checked against the actual repository during this
pass; see each file's own content for what was and wasn't verifiable).

**Rollback:** Delete the branch, or `git revert` the single commit. No
application state is affected either way.

---

## 2026-08-21 - Live time and timezone intelligence: AI tool surface
   (predates this changelog's creation - backfilled for completeness)

**Branch:** `feature/live-time-intelligence` (separate from this audit
branch; already pushed and independently verified)

**Changed:** Added the first-ever AI-invocable tool (`get_current_time`) to
the Gemini reply path. Security-relevant properties of this change:

- The tool is **read-only** - it has no corresponding write/set capability
  anywhere in the codebase, so no prompt-injection attempt against it can
  have a lasting effect beyond the current reply.
- The tool takes **no arguments** (empty parameter schema), so there is no
  input surface for the model to pass attacker-influenced data into it.
- Tool execution is **bounded to exactly one round trip** per reply -
  verified by a test (`test/aiReplyServiceRetry.test.ts`, "never lets a
  get_current_time tool call loop more than one extra round trip") that
  mocks a model response which keeps re-requesting the tool forever and
  confirms only one extra API call is ever made.
- A dedicated test (`test/aiReplyServiceRetry.test.ts`, "ignores
  attacker-controlled tool-call args entirely") proves that even if a
  compromised/manipulated model response includes forged
  `args` (e.g. a fake `utcNow`/`timezone`), the function-response sent back
  to the model is always the trusted, server-computed `TimeContext` - the
  forged values are never used.
- A manual time-override capability was added at the *business* level
  (`businesses.time_source`, `manual_override_target_utc`,
  `manual_override_set_at`), settable only via an authenticated,
  permission-gated (`settings.manage`) HTTP endpoint - **no AI tool can
  write these columns**, so no WhatsApp message, however crafted, can
  change what time the AI believes it is.

**Status:** `IMPLEMENTED AND VERIFIED` - 46 new tests added (see that
branch's own final report), full regression suite (76/76 files, 458/458
tests) passing with zero regressions against a corrected baseline.

**Rollback:** That branch has not been merged to any protected branch; it
can be discarded entirely (`git push origin --delete
feature/live-time-intelligence` after confirming no PR depends on it) with
zero effect on `phase-1-foundation`/the real base branch.
