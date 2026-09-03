# AURA Master Engineering Execution — Persistent Checklist

Tracking file for the 135-section master directive. Updated at the end of every section, per the protocol in the directive itself. Not committed to git unless you ask — this is a working document, not documentation of a finished system.

**Definition of "complete" used throughout:** implemented + tested + verified against real running code/DB + documented here. A file existing is not "complete." A page rendering is not "complete."

**Hard limits I'm keeping regardless of the "don't ask for approval" instruction:** real payment processing, production OAuth credentials, destructive migrations, and anything that spends real money or touches a real external account still get surfaced to you before I act — same as any other project. Everything else proceeds on my engineering judgment as instructed.

---

## Section 01 — Repository and architecture audit (this pass)

Findings, grounded in direct inspection (not from memory of the old commercial audit, which is partly stale):

| Area | Finding |
|---|---|
| AI Gateway split | Two real paths: `aiReplyService.ts` (customer replies, direct Gemini, circuit breakers, tool-calling) and `aiGateway.ts` (property triage/marketing/agent-builder, multi-provider failover, no circuit breaker of its own). Still unmerged. |
| AI tool policy | Real, enforced. `aiToolPolicy.ts` defines 6 registered tools across READ/WRITE/SEND/HIGH_RISK tiers; `agentGuard.ts` is a real, single enforcement gate (tenant check, actor check, rate limits, autonomy-level gating, audit log on every allow/deny). |
| Autonomy | Real 5-level ladder (`autonomy_level` on `ai_agents`, migration 961, built this session) — read-only / manual-approval / balanced / trusted+notify / fully autonomous. Enforced server-side, not just UI. |
| Approval queue | Real. `platform_action_requests` + `ApprovalService` + `ActionBus` with registered executors (Google Meet, Zoom, maintenance work orders). Approval-pattern suggestions exist (`getApprovalPatternSuggestions`). |
| Zoom / Google OAuth | Real OAuth service code exists (`zoomMeetingOAuthService.ts`, `googleMeetingOAuthService.ts`, `emailOAuthService.ts`) — token storage, refresh, connect/disconnect. Both explicitly check for `ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET` and Google equivalents and report unconfigured honestly rather than faking a connection. **Gap:** no central Integration Health page surfacing this status uniformly (Section 120). |
| Row-Level Security | 80 tables have RLS enabled across 3 dedicated migrations (944 core, 958 extend, 960 customer memory) out of 71 migrations that create tables. Substantially more coverage than an earlier "4 tables" estimate from a stale audit — that number is out of date. Have not yet verified every service query path actually runs under the RLS-scoped role vs. an admin bypass role. |
| Observability | No `pino` (or any structured logger) found anywhere in `src/`. 60+ files use raw `console.*`. Confirmed real gap (Section 69). |
| Queues (BullMQ) | 10 real queues exist (incoming/outbound messages, revocations, scheduled statuses, funnel-advance, email-send, document-parse, realtime-events). Have not yet verified retry/backoff/dead-letter config per-queue — flagged for Section 71 inspection, not yet done. |
| Webhook signature verification | No signature-verification code found anywhere in `src/`. WhatsApp itself isn't webhook-based here (Baileys socket, not Cloud API), so that specific case doesn't apply — but if/when Zoom or a payment provider webhook is added, there's no existing pattern to reuse. Flagged, not yet a live gap since no inbound webhook currently depends on it. |
| Storage / campaign attachments | No generic tenant-isolated file storage service exists yet. `mediaBase64` is accepted inline for WhatsApp Status and email (`whatsappOutboundMessageService.ts`, `scheduledStatusService.ts`) but there's no campaign-attachment upload path, no quota tracking, no `storage_files` table. Confirmed real gap (Sections 27-29). |
| Chat sync | `whatsappSyncService.ts` has no cursor/last-message/last-sync-timestamp based resume logic found in this pass. Needs a closer read before concluding it always full-resyncs, but no incremental-resume primitive was found. Flagged for real investigation in Section 25 (not yet done). |
| Payments | Confirmed still true from the last audit: no real payment processor. `paymentService.ts`/`providers/types.ts` exist as a real abstraction layer, but BiMPay is manual bank-transfer + human reconciliation, not automated. Section 73 requires provider verification for Barbados specifically before anything else — that's a business/compliance decision, going straight to the approval queue. |
| Trials | Real, correct 6-state `TrialState` (`CREATED/ACTIVE/EXPIRING/EXPIRED/CONVERTED/CANCELLED`), real password-based signup (shipped this session). |
| Property operations | Real: properties, incidents, work orders, vendor dispatch, AI triage with human approval, all backed by real Postgres tables, not mocks. |
| Campaigns / Marketing / Status | Real: `MarketingRoute.tsx` campaigns (create/review/approve/send/recall via real WhatsApp delete-for-everyone) and scheduled WhatsApp Status posts, both backed by real queues and real API calls. AI-suggested copy is real (Gemini via `suggestMarketingCopy`), clearly opt-in per message. |
| Funnels/Automations | Real drip-automation builder (`FunnelsRoute.tsx`) — nodes for message/wait/condition/assign/tag/CRM-stage-update/notify/email. Currently only linked into the nav for the `platform` vertical; just added to `property` this session after you reported it "disappeared." |
| CRM funnel/stage UI (Section 12's bug) | **FIXED.** Confirmed by you: lives in the leads pipeline board (Marketing area). Real bug: `PIPELINE_STATUSES.filter((s) => s !== lead.status)` only excluded the *current* stage, so every other stage — including ones already passed through — rendered as a "→ Stage" button on every re-render. Fixed via a new pure `nextPipelineOptions()` in `pipelineStages.ts`, forward-only with LOST always reachable and WON/LOST fully terminal. |
| Agent builder | Real, already fully implemented and live-tested earlier this session: `BuildAgentWizard.tsx`, `agentDescriptionParser.ts`, system `agent_templates` with provenance tracking. |

## Section 02 — Feature inventory (initial pass, not exhaustive)

| Feature | Status | Evidence |
|---|---|---|
| WhatsApp messaging (Baileys) | REAL | Live-paired, tested extensively this session |
| AI conversational replies | REAL | `aiReplyService.ts`, circuit breakers, tool-calling, prompt-injection boundary tagging |
| AI tool governor / permissions | REAL | `agentGuard.ts` |
| Agent autonomy levels | REAL (new) | This session, migration 961 |
| Approval queue / ActionBus | REAL | `platform_action_requests`, registered executors |
| Property ops (incidents/work orders/vendors) | REAL | Full triage-to-dispatch flow |
| CRM (contacts/leads/pipeline) | REAL | `CrmRoute.tsx`, real tables |
| CRM export | MISSING | No export endpoint found (Section 67) |
| Campaigns | REAL | Send/approve/recall, real WhatsApp API calls |
| Scheduled WhatsApp Status | REAL | Real publish/revoke against WhatsApp |
| Status comments/replies threading | MISSING | Requested by you earlier this turn-set, not yet built |
| Funnels/Automations | REAL, nav gap fixed | Was orphaned from `property` nav; fixed this session |
| Trial signup + password auth | REAL | Shipped this session |
| Zoom/Google Meet booking | REAL, credentials NOT_CONFIGURED locally | Code path real; env vars absent per your reported errors |
| Email (send/OAuth) | PARTIAL | `EmailRoute.tsx` + `emailOAuthService.ts` real; connection status needs the same "config missing vs. broken" honesty pass (Section 119) |
| Storage/campaign attachments | MISSING | No generic file storage system |
| Token/AI usage accounting | REAL | `ai_usage_events` (migration 954), surfaced in Developer Control Plane |
| Marketing research / timing engine | MISSING | Not found anywhere in `src/` |
| Autonomous overnight operations ("run while I sleep") | MISSING | No autonomous work-loop scheduler exists |
| Identity/name discovery engine | MISSING | No dedicated identity-resolution service found |
| Privacy/probing-detection engine | MISSING | Not found |
| Observability (structured logging) | MISSING | Confirmed, 60+ files on raw console |
| Global developer dashboard | PARTIAL | `DeveloperControlPlanePage.tsx` exists, real data, but not everything the spec wants (global search, feature flags, dangerous-action controls) |
| Billing/entitlements | REAL | Plan-gated, but payments themselves are manual |
| RLS / tenant isolation | REAL, broad but not 100%-audited | 80/71-plus tables covered; full query-path audit not yet done |

---

## Section 03 — Unified agent intelligence architecture

**Verdict: the core requirement ("shared infrastructure, not a separate implementation per agent") is already real and already met** — I'm not building a redundant new layer on top of it. Every customer-facing agent, regardless of persona/vertical, goes through exactly one pipeline:

- **One generation path per surface**: `aiReplyService.ts` for customer replies (all agents share it — persona/tone/category are data, not separate code paths), `aiGateway.ts` for everything else (triage, marketing copy, agent-builder parsing).
- **One tool registry**: `aiToolPolicy.ts` — every tool an agent can call is registered once, with a risk tier, regardless of which agent calls it.
- **One permission/safety gate**: `agentGuard.ts`'s `guardToolInvocation` — every tool call from every agent passes through this single function (tenant check, actor check, autonomy-level gating, rate limits, audit log). This *is* the "Permissions/Safety/Auditability" boxes from the spec, already real and already shared.
- **One approval/execution path**: `ApprovalService` + `ActionBus` — shared by meeting booking and property maintenance today, designed to take more executors without duplication.
- **One memory primitive that exists today**: `ConversationStateRepository` (goal/facts/open-questions per conversation) + `CustomerMemoryRepository` (cross-conversation facts) — this is real short-term/episodic memory, shared infrastructure, not per-agent.

**What's genuinely missing** (not a Section 03 architecture problem — these are dedicated later sections and should be built as new modules that plug into the pipeline above, not a rearchitecture of it):
- Identity/name-resolution engine (Sections 14-24) — no code exists yet.
- Personalisation budget / minimum-necessary-context selection (Section 20-21) — no code exists yet; today the full available context is what gets assembled, not filtered by a budget.
- Privacy decision engine / probing detection (Sections 82-91) — no code exists yet.
- Next-best-action ranking as its own reusable engine (Section 09) — pieces exist (approval-pattern suggestions, next-best-actions for the dashboard) but nothing agent-facing yet.
- Conversational funnel *state machine* (Section 06) — the "funnel" that exists today is the marketing drip-automation builder (`FunnelsRoute.tsx`), which is a different thing: user-authored automation sequences, not the AI inferring where a live conversation sits in a qualification funnel.

Each of those becomes its own real module (own repository/table where it needs persistence, own pure functions where it doesn't) that hangs off the *existing* single pipeline via new fields on `AiHandoffContext`/`GatewayRequest` — not a new competing architecture. That's the shared-infrastructure principle already established.

---

## Section 04 — Conversational intelligence engine (in progress)

The spec's pipeline has ~15 stages (contact ID → identity resolution → entity detection → intent classification → need detection → sensitive-info detection → risk analysis → permission evaluation → next-best-action → funnel state → persona → response generation → output safety check → response). Shipped this pass:

**New: `conversationIntentClassifier.ts`** — the entity-detection/intent-classification/sensitive-info/risk-analysis stages, combined into one deterministic (non-AI) module, run on every inbound message before the Gemini call:
- `intent`: greeting / scheduling_request / cancellation / complaint / confirmation / question / general — pattern-based, falls back to `general` rather than guessing on anything ambiguous.
- `entities`: email / phone / money, via regex.
- `sensitiveInfoDetected`: SSN-shaped and credit-card-shaped number patterns only — deliberately conservative (an ordinary phone number is never flagged).
- `riskLevel` (0-4, separate from confidence per Section 47's own rule): sensitive info or a complaint = 3, scheduling/cancellation = 2, question/confirmation = 1, greeting/general = 0.

**Wired into `aiReplyService.ts`**: fire-and-forget, before the Gemini call, never blocks or delays the reply. Only writes a real `security_audit_logs` row (new event type `message_risk_flagged`, migration 962, applied to both dev and test DBs) when risk >= 2 or sensitive info is detected — a routine greeting produces zero audit noise. The row stores the classification (intent, risk, entity *types*, not values) — never the raw message text, so a flagged SSN doesn't itself get persisted in plaintext anywhere new.

**Deliberately deterministic, not a second AI call** — per the master directive's own Section 101 performance guidance, and matching this codebase's existing `commitmentDetector.ts` precedent.

**Verification**: 13 new unit tests (`test/conversationIntentClassifier.test.ts`, all real inputs, no mocks needed since it's pure), full backend typecheck clean, full regression suite run in progress.

**Not yet built** (still open under Section 04/09/13): contact/identity resolution (needs Sections 14-24 first), need detection beyond intent, permission evaluation, next-best-action ranking, output safety check as a distinct stage (an output leak guard already exists separately - `outboundLeakGuard.ts` - but isn't yet connected to this new classification). Each of these is a real, separate unit of work, not a one-line addition - continuing section by section rather than claiming Section 04 fully done.

## Sections 06 & 10 — Invisible conversational funnel + customer readiness

Extended `conversation_states` (migration 963) with two real, model-writable fields, following the exact existing pattern (goal/facts/questions):
- `funnelStage`: NEW/CONVERSING/INTENT_IDENTIFIED/NEED_IDENTIFIED/QUALIFIED/SOLUTION_MATCHED/INTEREST_CONFIRMED/APPOINTMENT_OFFERED/APPOINTMENT_SELECTED/BOOKED/FOLLOW_UP/CUSTOMER
- `customerReadiness`: NOT_READY/BROWSING/NEEDS_INFORMATION/COMPARING/INTERESTED/HIGHLY_INTERESTED/READY_TO_ACT/URGENT

Both are **current-state snapshots** (overwritten, not merged/accumulated) - real DB CHECK constraint as defense-in-depth, and the model-facing tool schema uses a real `enum` constraint too. Critically, **closed the write→read loop**: the model can set these via `update_conversation_memory`, and `buildSystemInstruction` now feeds the last-set values back in on the next turn, explicitly marked "internal only, never mention this" - without this, the model would set state it could never see again, making it useless for actually steering the conversation.

**Verified**: typecheck clean, migrations applied to both DBs, 53 targeted tests passing (repository-level DB constraint test, writer-level overwrite-semantics test, system-instruction surfacing test) - full 255-file suite re-confirmed clean with these changes actually synced in (the first "clean" run reported earlier had predated syncing these files - re-ran properly before calling this done).

## Section 09 — Next-best-action engine (in progress)

The spec describes a per-conversation, per-turn action-type ranker (ANSWER/ASK/CLARIFY/RECOMMEND/OFFER_APPOINTMENT/...). This codebase already has a real, honest business-level version - `workspaceService.getNextBestActions()` - aggregating 5 real signal sources into a 2-tier (action_needed/suggestion) ranked dashboard list, never a fabricated numeric priority score. Extended it with a 6th real signal this pass, using the funnel_stage/customer_readiness fields just built in Sections 06/10:

- **New: `ConversationStateRepository.listHighReadinessForBusiness()`** - conversations where the AI has itself assessed the customer as READY_TO_ACT or URGENT, that the AI has NOT already escalated to a human, and that haven't already converted (BOOKED/CUSTOMER). This is a genuinely distinct signal from the existing "chat_needs_human" (which only fires on an explicit AI handoff) - it surfaces a case a human might want to jump into specifically *because* the AI is confident and the moment matters, not because the AI got stuck.
- Wired into `getNextBestActions` as a 6th aggregated source, `action_needed` tier (URGENT/READY_TO_ACT genuinely warrants attention, not just a nice-to-have).
- 3 new tests: surfaces correctly, never double-counts a chat already in HUMAN_TAKEOVER, never surfaces an already-converted conversation.

**Not yet built**: the spec's finer-grained ACTION_TYPE vocabulary (ANSWER/ASK/CLARIFY/QUALIFY/etc.) as the AI's own per-turn decision - today that decision is made implicitly by the model itself during reply generation, informed by the funnel-stage/readiness context fed back in (Section 06/10's work). Building a separate deterministic classifier to second-guess the model's own per-turn choice was deliberately not attempted this pass - real value unclear versus real complexity, would need product input before committing to it.

**Verified**: 10 tests passing (`test/nextBestActions.test.ts`), typecheck clean.

## Section 25 — Chat sync incremental resume (real bug found and fixed)

My Section 01 audit note on this ("no cursor-based resume logic found") was based on a shallow grep, not a full read - corrected here after actually reading `whatsappSyncService.ts` and `whatsappTenantConnection.ts` in full.

**Real finding**: the Baileys socket requests `syncFullHistory: true` on *every* connection (`whatsappTenantConnection.ts`), not only the very first device pairing - and real Baileys/WhatsApp sessions can and do resend a full `messaging-history.set` batch on an ordinary reconnect. `ingestHistorySet()` had no guard against this: it unconditionally ran every resent contact/chat/message back through `ingestContacts`/`ingestChats`/`ingestHistoryMessages`, even for an account whose `syncStatus` was already `'completed'`. Never corrupted data (every write is an idempotent upsert - real, existing protection), but real, unnecessary, potentially large reprocessing work on every reconnect - exactly what this section flags as the problem, even though "duplicate messages" specifically was already prevented.

**Fix**: `ingestHistorySet` now checks the account's `syncStatus` first and skips the entire reprocessing pipeline when it's already `'completed'` - logged honestly, not silently. `'failed'`/`'in_progress'`/`'not_started'` all still proceed normally, so resuming after a real failure keeps working (an explicit requirement of this section).

**Verified**: 7 tests passing (`test/whatsappSync.test.ts`, including the 2 new ones), typecheck clean. Full suite (255 files, 1862 tests) confirmed clean with everything through Section 25 included.

## Section 45 — Approval Centre (real gap found and fixed)

Investigated this expecting to build something new; found the backend already fully real and generic - `ApprovalService.approve/reject/listPending()` and `platformApprovalRouter.ts` (`/api/platform/approvals/pending|:id/approve|:id/reject|bulk-approve`) never assumed a specific action type. The code's own comments already say so explicitly.

**Real gap found**: the only UI for it - `ApprovalsTab` - was embedded as one tab inside `PropertyOperationsPage.tsx`, which only `platform` and `property` verticals have linked in the nav. This became a live, concrete problem the moment tonight's autonomy-ladder work (Sections 03-ish, done earlier tonight) shipped: **any** vertical's agent at autonomy level 1-2 now creates a real pending meeting-booking approval - but 8 of 10 verticals had no route to ever see or act on it. A food, retail, or auto business setting their agent to "Manual" autonomy would have had approvals silently piling up with zero way to reach them.

**Fix**:
- Extracted the tab into a real, shared, self-contained `ApprovalsPanel.tsx` component (own file, `src/web/src/components/`) - same backend calls, same approve/reject/bulk-approve behavior, unchanged for property's existing tab usage.
- Generalized the copy that assumed "maintenance request" / "work order" (header text, empty state, approve/reject confirmation copy) to be conditional on the actual action type - maintenance-triage keeps its original wording, everything else gets honest generic wording.
- Added a real summary line for non-maintenance action types (meeting bookings previously rendered with almost no information - just a badge and timestamp, nothing to actually inform an approve/reject decision).
- New `ApprovalsPage.tsx` + `/approvals` route, added to **all 11** verticals' nav (was previously reachable by 2 of 11).

**Verified**: frontend typecheck clean, production `vite build` succeeds with `ApprovalsPage`/`ApprovalsPanel` correctly split into their own chunks, no dangling references to the removed `ApprovalsTab` export anywhere in the codebase. Backend untouched (already real) - no new backend tests needed, existing `platformApprovalActionBusDispatch.test.ts`-class coverage still applies unchanged.

---

## Approval queue (running)

| # | Approval | Why required | What's already implemented | Exact action needed |
|---|---|---|---|---|
| 1 | Sections 41-42: Autonomous operations modes + overnight work loop | Real product/safety-policy decision: whether Aura should be allowed to detect work and take real, unsupervised actions on live customer conversations while no one is watching. This is qualitatively different from everything else built tonight (which either responds to real conversations with a human able to intervene, or holds actions for approval) - it is a genuine new capability with real consequences if wrong, not an implementation detail with two equally-safe technical choices. | Every safe primitive it would be built on already exists and is verified: per-agent autonomy levels (Section 03), the real Approval Centre now reachable by every vertical (Section 45), the Next-Best-Action engine (Section 09), and the Morning Briefing that would report on it (Section 48). | Tell me how far you want this to go - e.g. should "AUTONOMOUS" mode ever let an agent act without a pending approval at all, or should every mode still route through the existing approval queue and the only thing that changes is how proactively the system looks for work? |

## Section 48 — Autonomous Morning Briefing

Built the real thing Section 48 asks for - "what did Aura do while I was asleep" - as one aggregation reusing every real signal source already built tonight, not a second parallel system:

- **New**: `workspaceService.getMorningBriefing(businessId, sinceIso)` - completed/failed actions (`platformActionRepository.listByStatusSince`, new), pending approvals (existing `listPendingApprovals`), risk-flagged conversations (`securityAuditLogRepository.listByTypeSince`, new - surfaces Section 04's `message_risk_flagged` events for the first time anywhere), chats needing a human (existing), new appointments (`scheduledMeetingsRepository.listCreatedSince`, new), new leads (`leadRepository.listCreatedSince`, new), overdue invoices (existing), and recommended priorities (literally `getNextBestActions()` reused, not reimplemented).
- New `GET /api/workspace/morning-briefing?sinceHours=N` route (default 12h lookback - explicit, not a fabricated "since you went to sleep" precision this system has no real way to know).
- New "Since you last checked" card on the real Dashboard - compact counts only, links to `/approvals` and `/crm` where a real destination exists, deliberately does NOT duplicate the "What to do next" list already on the same page.
- **Also fixed in passing**: `NextBestAction`'s frontend type (`api.ts`) was missing the `'high_readiness_conversation'` variant added to the backend in Section 09 earlier tonight - real drift, caught and fixed here.
- **Deliberately deferred**: the "why did you do that?" per-action explain endpoint (a real, separate, smaller feature - reading `platform_audit_events` for one action and summarizing deterministically) - noted, not built this pass, to avoid scope creep on an already-large section.

**Verified**: 9 new tests (`test/morningBriefing.test.ts`, real Postgres, includes a tenant-isolation test and one proving `recommendedPriorities` is byte-for-byte the same list `getNextBestActions` returns - never a drifting second copy), full typecheck clean, production frontend build succeeds, full suite (256 files, 1871 tests) re-confirmed clean.

## Section 67 — CRM Data Export

Real, customer-controlled export of every contact and lead a business owns, in CSV or JSON.

- **New**: `src/services/export/csvExport.ts` - a minimal, dependency-free RFC 4180-style CSV writer (proper quoting/escaping of commas, quotes, newlines; never emits the literal string "null"). No new library for something this small.
- **New**: `workspaceService.exportCrmData(businessId)` - real contacts + leads, capped at a generous 50,000 rows (a real safety bound, not a fabricated "unlimited" promise). Respects existing privacy flags automatically - a contact marked `isHidden` by the business's own settings is excluded from export, since `listByBusiness` already filters it (verified with a dedicated test, not just assumed).
- **New route**: `GET /api/workspace/crm/export?format=csv|json`, gated on the `reports.export` permission (already defined in the RBAC permission set, never previously used anywhere - this is its first real consumer) - a real downloadable file with a proper `Content-Disposition` header, not a JSON blob dressed up as an export.
- **New**: `downloadCrmExport()` in `api.ts` - real browser download (blob + object URL + synthetic click), and a real "Export CSV" button on the CRM page.

**Verified**: 9 unit tests for the CSV writer, 5 integration tests for the export aggregation (real Postgres, includes a privacy-exclusion test and a tenant-isolation test), full typecheck clean, production frontend build succeeds.

## Sections 14-24 — Identity & Name Discovery Engine (in progress)

Confirmed real, complete gap in Section 01's audit - zero identity resolution existed anywhere before this pass; `buildSystemInstruction` never referenced the customer's name at all. Built the first real, working slice:

**New: `src/services/ai/identityEngine.ts`** - deterministic (no AI call), pure, fully unit-tested:
- `resolveNameEvidence()` (Sections 15/16) - a real source hierarchy: confirmed preferred name (Tier 2, self-identified) > WhatsApp verified name > business name > push name > username > short name. Never assumes a WhatsApp display name is a real name (Section 14's own explicit rule) - a push name only ever reaches `POSSIBLE_REAL_NAME`, never higher.
- `shouldUseName()` (Sections 18/19) - first use in a conversation is always natural; after that, a real 15-minute time-based cooldown rather than using the name on every single turn. A bare phone-number fallback is never treated as a name to greet someone with.
- `replyUsesName()` - deterministic, word-boundary-matched detection of whether a reply text actually contains the resolved name - drives the cooldown from what really went out, never from what the model self-reports.

**Wired into the real pipeline**:
- `conversation_states` gains `preferred_name` (model-writable via `update_conversation_memory`, same pattern as funnel_stage/customer_readiness) and `last_name_used_at` (system-set only, migration 964, applied to both DBs).
- `aiContextGathererService.ts` now fetches the real WhatsApp contact record and exposes its name fields (`contactNameSources`) on `AiHandoffContext` - raw material only, never treated as a resolved identity until identityEngine.ts classifies it.
- `buildSystemInstruction` resolves evidence and tells the model, when there's real evidence and the cooldown has cleared, that it may naturally use the name this turn (or, when it was just used, not to repeat it) - always framed as internal-only, never customer-visible guidance.
- After a real reply is generated (both the primary and Goose-fallback paths), the system checks whether the actual reply text used the name and only then records `last_name_used_at` - a system fact, never a model-reported one.

**Deliberately deferred** (real, separate future work, not fabricated as done here): cross-conversation preferred-name carry-over (Section 20's "personalisation budget" - would extend `customer_memory`, not `conversation_states`), the "important moment" cooldown override (Section 19's adaptive exceptions for reassurance/emotional moments), and manually-saved contact names with a real UI (Section 23 - needs its own schema and page, not a side effect of this pass). Sections 25 onward under this umbrella (identity evidence graph persistence, real/alias classification UI, personalisation settings) also remain open.

**Verified**: 15 new unit tests for the identity engine, 6 new `buildSystemInstruction` tests (name offered/withheld/hierarchy-fallback), 2 new writer tests (`preferredName` set/cleared, `recordNameUsed` persists a real timestamp) - 72 tests total across the touched files, all passing. Typecheck clean (both backend and frontend), production frontend build unaffected (backend-only change). Full 259-file suite re-confirmed clean (1904/1906 passed; the 2 failures were the same known BullMQ-timing-under-load flakiness - both passed cleanly in isolation, see memory).

## "Status comments" — real reply-to-status detection (your direct request)

Investigated properly before building: WhatsApp Status has no public comment thread (unlike Instagram/Facebook) - a "reply" to a status is a private message to the poster, but it genuinely carries a real reference back to which status it replied to (Baileys' `contextInfo.stanzaId`, protobuf-confirmed via `IStatusMentionMessage`). Better still: this codebase already extracts that exact field (`quotedStanzaId`) during ingestion for ordinary quoted-message replies - it just only ever looked it up against `whatsapp_messages`, which a status was never inserted into, so a real status-reply's reference was silently discarded.

**Fix, built on that existing hook rather than touching the ingestion pipeline itself**:
- `scheduledStatusRepository.findByPublishedWhatsappMessageId()` - resolves a quoted stanza id to the real status it replied to.
- `whatsappMessageRepository.recordStatusReply()` / `listRepliesToStatus()` - stored in the message's existing `raw_metadata` (same convention as `mentionedJids` - no new column on the hot message table).
- `whatsappMessagePersistenceService.ts`: after the real message is already durably committed (never inside the transaction - a lookup failure must never fail the message write), checks whether an unresolved quote matches a published status and tags it. An ordinary chat-message quote always takes priority and is never overridden.
- New `GET /api/workspace/scheduled-statuses/:id/replies` route, `listStatusReplies()` service function.
- Real UI: a "View replies" toggle per published status in the Marketing → Status tab, fetched on demand (not preloaded for every status - avoids an N+1 query on page load).

**Verified**: 4 new integration tests (real Postgres, real transaction) - tags a genuine status reply, leaves rawMetadata untouched for an unmatched quote, never lets a status match override a real ordinary-message quote, and a tenant-isolation test on the replies endpoint. All 24 tests in the touched file pass. Typecheck clean both sides, production frontend build succeeds.

## Section 56 — Appointment System (real gap found and fixed)

Investigated expecting a moderate polish task; found something much more significant: `scheduled_meetings` (the real, working Google Meet/Zoom booking table the AI has been writing to all session) had **zero UPDATE statements anywhere in the codebase**. A meeting's status never changed after creation - `cancelled`/`failed` were declared types nothing ever set. And **zero frontend surface existed anywhere** - not a dedicated page, not even a per-chat view - for a real, live system that books real calendar events and sends real invites on the business's behalf.

**Fixed**:
- Migration 965 extends the status lifecycle to `completed`/`no_show` (`confirmed`/`cancelled`/`failed` already existed as types, unused).
- Real mutation methods, the first ever for this table: `markCancelled` (human-initiated, confirmed-only, tenant-scoped), `markNoShow` (deliberately human-only - attendance isn't something this system can know on its own), `markCompleted` (only ever set by the sweep below).
- New `meeting-completion-sweep` (every 5 min, same real `upsertJobScheduler` pattern as the 10 other real sweeps already running) - marks a `confirmed` meeting `completed` once its real end time has passed. A genuinely computable fact, never a guess about attendance.
- New `AppointmentsPage.tsx` + `/appointments` route, added to **all 11 verticals** - upcoming/past split, join links, cancel/no-show actions. First-ever UI for this real booking data.
- New `GET /api/workspace/appointments`, `POST /api/workspace/appointments/:id/cancel`, `POST /api/workspace/appointments/:id/no-show`.

**Verified**: 9 new repository tests (listForBusiness ordering, markCancelled/markNoShow tenant-scoping and confirmed-only guards, findConfirmedPastEnd's real filtering) + 4 new sweep tests (marks a genuine past meeting completed, never touches an upcoming one, never overrides a human's cancel/no-show decision even past its end time, idempotent on a second run) - 13 tests total, all passing. Typecheck clean both sides, production frontend build succeeds with `AppointmentsPage` in its own chunk.

## Section 26 — Message delivery status reconciliation (the exact symptom the directive describes, found and fixed)

The directive's own wording ("total 0, queued 0, sent 0, delivered 0, read 0, failed 0 - the dashboard is not updating") looked hypothetical at first read - the campaign status computation is a genuinely well-designed, live-computed JOIN (`campaignRepository.ts`), not a stale duplicated counter, and every piece of the real pipeline (dispatch → outbound row → Baileys echo → `linkPersistedMessage` → real ack → `processMessageStatus`) traced out correctly on inspection. No test exercised the delivered/read path at all, though - so instead of concluding "looks fine," wrote a real end-to-end test exercising every one of those real production functions directly (not mocked), and it caught a genuine, live bug:

**Real bug**: `whatsapp_messages.status` is `NOT NULL DEFAULT 'unknown'` (migration 007) - never actually `NULL` for a real row. The recipient-status `CASE` and the aggregate counts query both checked `wm.status IS NULL` to mean "no real delivery ack yet" - a condition that can never be true. The moment a sent message got echoed back and linked (`linkPersistedMessage`), its status flipped to the literal placeholder `'unknown'` instead of `'sent'` - and the aggregate counts query excluded it from every single bucket (not sent, not delivered, not read, not failed) until a real ack eventually arrived. A recipient in exactly that window is precisely the directive's "stuck at 0" symptom.

**Fix**: both places now treat `wm.status = 'unknown'` the same as "no real ack yet," falling through to the outbound message's own real `'sent'` status instead of leaking the placeholder.

**Verified**: new end-to-end test in `test/campaignService.test.ts` exercises the real chain start to finish - `markSent` → a real `whatsapp_messages` insert (the Baileys-echo simulation) → `linkPersistedMessage` → the real (now-exported) `processMessageStatus` handler for a `delivered` ack, then a `read` ack - asserting the aggregate counts and per-recipient status correctly transition at each step, never double-counting. All 12 tests in the file pass; typecheck clean.

**Real bug this section's own full-suite run caught**: `test/routeAuthorization.test.ts` - a real, deliberate security test that statically checks every mutating `/api/workspace` route in `server/index.ts` either has `requirePermission(...)` or is on a hand-reviewed self-scoped allowlist - failed because my two new POST routes (`/appointments/:id/cancel`, `/appointments/:id/no-show`) only had `requireWorkspaceContext`, no permission check. This did NOT get waved off as flakiness - investigated properly, confirmed real, fixed by adding `requirePermission('crm.edit')` to both (matching the existing pattern for other CRM-adjacent mutations). A second failure in the same run (`aiOrchestratorOutboundGuard.test.ts`, a 15s timeout) WAS confirmed genuinely flaky - passed cleanly in isolation, unrelated code path. Both were investigated with the same rigor rather than assuming either was "probably fine."

---

## Section 71 — Queue reliability (real gap found and fixed)

Inspected all 10 real BullMQ queues (`grep attempts:|backoff:` across `src/queue/queues/*.ts`): every one has real `attempts` (2-5) and exponential `backoff` configured. Not a gap.

Then checked whether the 7 workers' `.on('failed', ...)` handlers actually reconcile the underlying business record to a terminal state once retries are exhausted, or just log. Read every one's full job-processing body, not just the handler:

- `outboundDispatchWorker.ts`, `scheduledStatusPublishWorker.ts` — already correct: check `attemptsMade >= maxAttempts` in the handler and call the repository's `markFailed`/`updateStatus('FAILED')`.
- `messageRevocationWorker.ts` — already correct, but reconciles *inline* inside the job's own catch block (`isFinalAttempt(job)` check before `markRevokeFailed`), not in the `.on('failed')` handler — same outcome, different shape.
- `funnelAdvanceWorker.ts` — already correct via a different, pre-existing mechanism: `runFromPosition`'s own try/catch reconciles any thrown error to `status: 'FAILED'` immediately (not retry-dependent), and a dedicated `sweepStaleFunnelInstances()` (already wired, 5-minute interval) catches an instance abandoned mid-WAIT with no job left to resume it.
- `incomingMessagesWorker.ts` (both queues) — safe by construction: message persistence is a single transactional write, so a thrown error rolls back cleanly with nothing left half-done; a genuine retry re-attempts from scratch.
- `emailSendWorker.ts` — narrower case checked and confirmed already covered: `sendEmail()` never throws (fully try/caught, always returns a clean `{status, reason}`), and the one real risk window (a DB write throwing *after* a real send succeeded, stranding the row at `status='sending'`) is already caught by the pre-existing `sweepStaleEmails()` (`findStalePending`/`markIndeterminate`, wired at 60s interval) — confirmed this is actually wired into the dispatch switch, not dead code.
- **`documentParseWorker.ts` — real gap, confirmed and fixed.** `processDocumentParseJob` calls `markDocumentProcessing` (status → `'processing'`) *before* attempting the parse. Its own "already past uploaded, skip duplicate job" guard (`status !== 'uploaded'`) is correct and necessary for genuine duplicate/retry idempotency (there's a dedicated existing test for exactly that). But if `parseDocument()` or anything after it throws an *unexpected* exception (as opposed to returning a handled `{status:'failed'}`) — e.g. a parser library crash — every subsequent BullMQ retry re-fetches the document, finds `status === 'processing'` (not `'uploaded'`), and takes the early-return guard path, which does **not** throw. BullMQ therefore records the retry as a successful completion, the job never reaches a final `'failed'` state, and the document is left silently and permanently stuck at `status='processing'` forever — invisible to any user, no error, no audit trail. This is the same reconciliation-gap class the master directive names, just one queue over from the one already fixed in Section 26.

**Fix**: added `findStaleProcessing(staleAfterSeconds)` to `businessDocumentRepository.ts` (documents stuck at `status='processing'` past a staleness window, matching `findStalePending`/`findStaleWaiting`'s existing pattern) and a new `sweepStaleProcessingDocuments()` in `incomingMessagesWorker.ts`, wired into the same `realtimeEventsQueue` sweep-dispatch switch and `upsertJobScheduler` registration as every other sweep (`document-processing-timeout-sweep`, every 60s, 300s staleness threshold). It reconciles both the version (`markVersionFailed(..., 'processing_error')`) and the document (`markDocumentFailedIfCurrentVersion`) and notifies the business, exactly mirroring `sweepStaleEmails`/`sweepStaleFunnelInstances`.

**A dead-end worth recording**: first attempted the fix as an `.on('failed')` handler checking `attemptsMade >= maxAttempts` (matching `outboundDispatchWorker`'s pattern) on both `documentParseWorker` and, defensively, `emailSendWorker`. Realized on closer trace that this is dead code for exactly the failure mode it targets: once the *first* attempt throws, every subsequent retry silently no-ops as a false "success" (per the guard above), so the job never reaches a truly final `'failed'` state — `attemptsMade >= maxAttempts` is never true when it matters. Reverted both; the staleness-sweep pattern is the only correct fix here, which is presumably why the codebase already used it for the identical email/funnel cases.

**Verified**: new `test/documentProcessingSweep.test.ts` (5 tests, real Postgres) — reconciles a genuinely stuck document to `failed`; never touches one still within the staleness window; never touches one that finished normally; sweep is idempotent (safe to run twice); never resurrects a document deleted while stuck. All pass. Backend typecheck clean. Full regression suite re-run clean (260+ files, 3 unrelated flaky real-Gemini-API timeouts confirmed by isolated re-run - see [[project_flaky_circuit_breaker_test]] memory, instance 4).

---

## Section 49 — Emergency controls (real gap found and fixed: campaign mid-send stop)

Checked what "kill switch" coverage already exists before assuming a gap. Two real controls were already there and are genuinely complete: (1) per-agent pause/archive (`PATCH /api/workspace/agents/:agentId/status`, explicitly commented in `server/index.ts` as "the real AI kill switch") - and since `findActiveForBusiness()` returns at most one agent per business (`LIMIT 1`), pausing it is already a complete stop of all AI-generated replies for that business, not a partial one; (2) per-conversation human-takeover (`setAiMode` → `AI_PAUSED`/`HUMAN_TAKEOVER`). Both already real, already tested, not touched.

**Real gap found**: `cancelCampaign()` refused any status other than `DRAFT`/`REVIEW`/`APPROVED`. But `sendCampaign()` enqueues every recipient's outbound message essentially synchronously (a real `whatsapp_outbound_messages` row created 'queued' for every recipient in one loop, each with a staggered `SEND_STAGGER_MS` (4s) BullMQ delay) - so for up to `MAX_RECIPIENTS_PER_CAMPAIGN` (100) × 4s ≈ 6.5 minutes after clicking Send, some recipients genuinely have not been messaged yet. A business that spots a mistake (wrong price, wrong message, wrong recipient list) seconds after sending had no way to stop the remaining recipients - the frontend didn't even offer a Cancel button once `RUNNING`, matching the backend's own refusal.

**Fix**: added `'cancelled'` to `OutboundMessageStatus` (migration 966, applied to both DBs) and `whatsappOutboundMessageRepository.cancelQueuedByIds()` - a guarded bulk UPDATE that only ever matches rows still `status='queued'`, mirroring `outboundDispatchWorker`'s own `'sent'`/`'indeterminate'` skip-guard (extended to also skip `'cancelled'`) so a message already `'sending'`/`'sent'` is never raced. `campaignRepository.listOutboundMessageIds()` finds a campaign's recipient message ids; `cancelCampaign()` now allows `RUNNING`, and when it was, bulk-cancels every still-queued one and audit-logs `stoppedCount`. `getStatusCounts()` gained a `cancelled` bucket (was previously silently absent from every bucket - present in `total` but invisible in the breakdown) so the UI shows an honest number rather than queued/sent/delivered/read/failed no longer summing to total. Frontend: a real "Stop sending" button (`MarketingRoute.tsx`) shown only while `status === 'RUNNING' && counts.queued > 0`, distinct from the existing "Delete from WhatsApp" (recall) action which handles messages already sent.

**Verified**: extended `test/campaignService.test.ts` (4 new/rewritten tests, real Postgres) - stopping a RUNNING campaign cancels a still-queued recipient while leaving one already `'sent'` untouched; a repeat cancel on an already-CANCELLED campaign is refused (real terminal state, not silently repeatable); pre-send cancel still works. 15/15 pass. Backend + frontend typecheck clean, production build compiles, full regression suite re-run (3 failures, all the same confirmed-flaky real-Gemini-timeout class plus one self-inflicted rsync-race false alarm in my own new test - see [[project_flaky_circuit_breaker_test]] instance 5 - none touching campaign/outbound code).

---

## Section 66 — CRM identity profile fields on the contact view

**Real gap found**: `identityEngine.ts` (Sections 14-24) already resolves a real name-source hierarchy (verified > business > push > username > short) to personalize AI replies, and `crmContactRepository`'s own `listByBusiness` query already joins in every one of those source fields (`contactVerifiedName`/`contactBusinessName`/`contactPushName`/`contactShortName`) - but `workspaceService.toCrmContactSummary()` only ever used them to compute a single collapsed `displayName`, then discarded the individual fields before they reached the API response. Staff had no way to see, from the CRM contact view, which source AURA is actually drawing from, or that a "verified name" (WhatsApp's own confirmed identity) and a "push name" (whatever the customer's own phone happens to be set to - can be a nickname, an emoji, a shared family device's name) are very different in trustworthiness.

**Fix**: extended `WorkspaceCrmContactSummary` (backend and the matching frontend type in `api.ts`) with `verifiedName`/`businessName`/`pushName`/`shortName`, populated in `toCrmContactSummary()` from data the query already had - no new query, no new join. Added a read-only "Identity sources" panel to `ContactDetailCard` (`CrmRoute.tsx`) showing each source with a one-line hint on what it means and how trustworthy it is, dimmed when WhatsApp never supplied that field, with an honest "no name information yet" state when none are known.

**Deliberately scoped out for now**: cross-referencing the conversation's self-identified `preferredName` (set only from explicit self-identification, see Sections 14-24) would need resolving a `chatId` from the CRM contact's `whatsappContactId` first (conversation state is keyed by chat, not by CRM contact) - a real join CRM doesn't currently have a clean path for. Left as a follow-up rather than bolting on an extra join for this pass.

**Verified**: new test in `test/workspaceServiceCrm.test.ts` - a contact with all four real sources set surfaces them all correctly; a contact with only a push name shows the other three as honestly `null`, never fabricated. Backend + frontend typecheck clean.

---

## Section 92 — Loop protection (real gap found and fixed: funnel CONDITION cycles)

Checked each named sub-category against real code rather than assuming full coverage:

- **Agent loops / repeated tool calls**: already real and solid. `resolveToolCalls()` in `aiReplyService.ts` is explicitly, deliberately bounded to exactly one round of tool calls with a doc comment stating why ("a model that somehow kept re-requesting a tool could never turn one inbound WhatsApp message into an unbounded chain of API calls"). Not touched.
- **Retry storms**: already covered by Section 71's findings - every real BullMQ queue has bounded `attempts` + exponential `backoff`.
- **Recursive delegation / webhook loops**: not applicable to this architecture - there is no agent-to-agent delegation, and (per Section 01's audit) no inbound webhook path exists (Baileys is a live socket, not a webhook).
- **Campaign loops**: not applicable - a campaign is a one-shot bounded send (`MAX_RECIPIENTS_PER_CAMPAIGN`), never a recurring/self-triggering loop.
- **Automation (funnel) loops — real gap found**: `runFromPosition()` (`funnelService.ts`) executes a `while (position < steps.length)` loop with no iteration cap. A `CONDITION` step's `matchStepPosition`/`elseStepPosition` are validated only to be a real in-range step index (`validateStep`) - **not** that they're forward of the current position. A funnel with two `CONDITION` steps whose branches route back to each other (accidentally authored, or deliberately probed for) has no `WAIT`/`MESSAGE` in the cycle to ever pause or complete it, so the loop spins forever. Because `enrollContact()` and `resumeFunnelInstance()` both `await runFromPosition()` directly, this isn't just a stuck instance - the real HTTP enroll request or the real BullMQ `funnelAdvanceWorker` job hangs indefinitely.

**Fix**: a synchronous-step counter inside `runFromPosition()`'s loop, capped at `Math.max(50, steps.length * 5)` - generous enough for any real funnel's legitimate forward traversal (plus the occasional deliberate backtrack), but small enough that a genuine cycle is caught in milliseconds. Exceeding it throws from inside the loop's existing `try`, so it's reconciled through the exact same honest-failure path (`status: 'FAILED'`, `lastError` set) any other real step error already takes - no new failure mechanism introduced.

**Verified**: new test in `test/funnelService.test.ts` - a real 2-step CONDITION cycle (mutually always-false branches routing back and forth) resolves `enrollContact()` promptly (391ms, not a hang) to `status: 'FAILED'` with a clear `lastError`. All 14 tests in the file pass. Backend typecheck clean.

---

## Sections 57-59 — Zoom/Google booking: real gap found and fixed (dead OAuth connection fails silently)

**Real gap found**: `bookGoogleMeeting()` and `bookZoomMeeting()` (the one real booking implementation each provider's AI tool-call path and operator-approval-executor path both share) both correctly return an honest `{ booked: false, reason: 'token_invalid' }` when `getValidAccessToken()` can't produce a usable token - but a dead refresh token (the customer revoked access from their own Google/Zoom account settings, or it simply expired) fails **identically on every future booking attempt**, and nothing in the system ever surfaced this to staff. Traced the full path: the immediate AI tool-call branch (`aiReplyService.ts`) only calls `notifyAutonomousAction` on the *success* branch; the operator-approval executor path (`actionBusService.ts`) marks the action row `FAILED` but never calls `notifyBusiness` on any execution failure. A business's Google/Zoom integration could be completely dead for days, with every real booking attempt quietly failing (the customer just gets told "the AI couldn't book that"), and staff would only discover it by noticing the pattern themselves or a customer complaining.

**Fix**: added a `notifyBusiness` call directly inside `bookGoogleMeeting.ts`/`bookZoomMeeting.ts` at the `token_invalid` branch (the shared function both callers use, so the fix covers both the immediate and approval-executed paths with one change, matching the file's existing "one real booking implementation" design). Deliberately scoped to `token_invalid` only, not `not_connected` (a business that never connected the integration in the first place already knows that - alerting them would be noise, not new information) or the generic `calendar_api_error`/`zoom_api_error` (a one-off provider hiccup isn't necessarily something staff need to act on the way a dead connection is).

**Verified**: two new tests in `test/meetingBookingExecutors.test.ts` - a connection with an expired token and a refresh call mocked to fail with a real `invalid_grant`-shaped 400 response correctly reports `FAILED`/`token_invalid` AND writes a real `AUTOMATION_FAILURE` notification naming the dead connection, for both Google and Zoom. All 6 tests in the file pass (up from 4). Backend typecheck clean.

---

## Sections 46-47 — Approval policy / risk engine: real gap found and fixed (stale approval books a meeting for a moment already gone)

**Real gap found**: `ApprovalService.decide()` (`approvalService.ts`) has no concept of a deadline - it will happily approve a `PENDING_APPROVAL` action any number of days after it was requested, which is by design (approval delay is expected, not a bug). But for the two meeting-booking action types specifically, the payload carries its own `startDateTimeIso`, and neither `bookGoogleMeeting()` nor `bookZoomMeeting()` ever checked that time against the current moment - only that it parsed as a valid date. An agent at autonomy level 1-2 requests a Google Meet or Zoom booking for tomorrow at 3pm; staff don't get to the Approvals page until three days later; clicking Approve would have silently created a real Calendar event / Zoom meeting, and sent the customer a real invite, for a moment that had already passed - confusing at best, and a real, avoidable customer-facing embarrassment.

**Fix**: both shared booking functions now check `startAt` against `Date.now()` (with a 60-second grace window for ordinary processing delay) immediately after the existing `invalid_start_time` check, before ever calling the real Calendar/Zoom API - returning a new, honest `start_time_already_passed` reason instead. Placed in the one shared function both the immediate-AI and approval-executor paths call, same as the Sections 57-59 fix.

**Verified**: two new tests in `test/meetingBookingExecutors.test.ts` - an approved action whose `startDateTimeIso` is years in the past is refused with `start_time_already_passed`, never calls the real Calendar/Zoom API (`fetchMock` untouched), and never creates a `scheduled_meetings` row, for both Google and Zoom. All 8 tests in the file pass (up from 6); confirmed the existing 13 AI-tool-call tests (`scheduleMeetingTool.test.ts`/`scheduleZoomMeetingTool.test.ts`) still pass unaffected, since their fixture date (`2030-06-01`) stays safely in the future. Backend typecheck clean.

---

## Sections 43-44 — Work queue states: real gap found and fixed (a FAILED execution still told staff "approved")

**Real gap found**, while re-reading the exact code path the previous fix runs through: `runPostApprovalSideEffects()` (`platformApprovalRouter.ts`, shared by both the single-approve and bulk-approve routes) calls `actionBusService.execute()` after every approval, and when that real dispatch comes back `FAILED` - including from the `start_time_already_passed`/`token_invalid` cases just fixed, or any other executor failure - the only thing that happened was a `console.error`. The function then fell straight through to an **unconditional** `notifyBusiness({ title: 'Action request approved', ... })` regardless of `dispatch.status`. Staff saw "approved" and had every reason to believe the real side effect (the Calendar booking, the work order) had happened, when it had actually, silently failed - the exact opposite of what the notification said. Only a `DENIED` result (the legitimate "no executor registered for this action type" case) was meant to still say "approved," since nothing was ever supposed to execute there.

**Fix**: branched on `dispatch.status === 'FAILED'` - that path now sends a distinct, honest `AUTOMATION_FAILURE` notification ("An approved action failed to execute", with the real `dispatch.error` in the body) and returns before ever reaching the generic "approved" notification. `DENIED`/`SUCCEEDED` are unaffected, preserving the existing "no executor registered is benign" behavior.

**Verified**: two new tests in `test/platformApprovalActionBusDispatch.test.ts` (exported `runPostApprovalSideEffects` for direct testing, matching the file's existing pattern for `actionRowToRequest`) - a real FAILED dispatch (a Google Meet action with no connection at all) writes exactly one notification, of type `AUTOMATION_FAILURE`, titled "failed to execute", never the misleading "approved" one; a genuinely SUCCEEDED dispatch still gets the ordinary "approved" notification, unaffected. All 9 tests in the file pass (up from 7). Backend typecheck clean.

---

## Sections 34-40 — Token economy, budgets, cost control, display (real gap found and fixed)

**Real gap found**: `max_ai_agents`, `max_whatsapp_accounts`, etc. capped how many *things* a business could create, but nothing anywhere capped what one active agent could actually *spend* generating real replies - a business could run an agent indefinitely with zero cost ceiling. Separately, `plans`/`plan_entitlements` (migration 025) were only ever editable by hand-editing a migration file, despite that migration's own seed comment promising "illustrative starting values... the business can change."

**Fix**: (1) `plan_entitlements` gained a real `max_ai_tokens_per_month` key (migration 967), seeded with generous developer-adjustable defaults (500K/2M/10M/unlimited across starter/growth/business/enterprise). (2) `PlanRepository` gained real write paths - `updatePlan()`, `upsertEntitlement()`, `listAll()` - previously read-only. (3) A new developer-only "Plan Management" section on the Developer Control Plane edits any plan's price and any entitlement's limit/enabled state inline, backed by new `requireDeveloper`-gated routes (`GET/PATCH /api/billing/developer/plans`, `PUT .../entitlements/:key`). (4) `EntitlementService.canUseAiThisMonth()` checks the real running monthly token total (`AiUsageRepository.getMonthlyTotalForBusiness`, `date_trunc('month', now())`) against the plan's limit. (5) `orchestrateAiReply` calls this once per inbound message, right before the real Gemini call - over-budget hands off to a human via the same honest `unavailable` outcome an out-of-credentials failure already produces, so the worker's existing hand-off/notify logic needed zero changes. (6) The business's own real billing page (`getBillingOverview`) now shows real AI token usage against its plan's budget, not just a developer-facing aggregate - the same generic `UsageMeter` component every other entitlement already used, now also formatting large numbers with `.toLocaleString()`.

**Real regression caught and fixed during this pass**: the initial version of the budget gate blocked *any* business with no active subscription from getting AI replies at all - a behavior change well beyond the token-budget feature, since many pre-existing tests (and potentially real edge cases) use a bare business record with no subscription and expect AI replies to work regardless. Fixed by only enforcing the gate when a subscription actually exists (`NO_ACTIVE_SUBSCRIPTION` no longer blocks; only `ENTITLEMENT_DISABLED` - a real plan configured with no AI access - and `ENTITLEMENT_LIMIT_REACHED` do).

**Verified**: `test/planAdmin.test.ts` (11 tests, repository writes), `test/aiOrchestratorBudgetGate.test.ts` (the over-budget hand-off, without needing GEMINI_API_KEY since the gate fires before that call), 4 new cases in `test/entitlementService.test.ts`, 1 new case in `test/workspaceServiceBilling.test.ts`. Live HTTP round-trip verified against the real dev database (list/patch/put all correct, then restored). Full backend typecheck clean (backend + frontend). Not yet verified: the rendered Plan Management React page in an actual browser - it sits behind a WhatsApp-pairing gate reconciled live against a real Baileys socket, which resists faking via direct DB rows; the component itself reuses patterns already working elsewhere on the same page.

**Still open** (34-40's remaining scope): a business-initiated approval/override flow for exceeding budget (currently a hard stop to human hand-off, no self-serve request-more-budget path), and deeper AI cost analytics beyond the existing 24h/7d aggregate view.

---

## Section 23 — Manually-saved contact names (real gap found and fixed)

**Real gap found**: identityEngine.ts's own header comment had flagged this as deliberately deferred since the original Sections 14-24 pass ("needs its own schema and page, not a side effect of this pass") - `crm_contacts` had no field for it, and staff had no way to correct a name the automatic sources (WhatsApp verified name, push name, self-identified preferred name) got wrong, even though the AI would keep using the wrong one indefinitely.

**Fix**: `crm_contacts.manual_display_name` (migration 968), a real, staff-editable text field, plumbed through as the single highest-priority tier everywhere a contact's name is resolved:
- `identityEngine.ts`: new `STAFF_CONFIRMED_NAME` tier, checked first in `resolveNameEvidence()` - outranks even the customer's own self-reported preferred name (Section 15's `CONFIRMED_PREFERRED_NAME`), since a human can catch something the automatic sources got wrong.
- `domain/whatsapp/displayName.ts`'s `resolveDisplayName()` (the separate, general-purpose function used everywhere a contact's name is just *displayed*, not used for AI personalization) gained the same top tier - a staff correction now shows up as the actual name in the CRM list/detail view and lead list, not just inside AI replies.
- `aiContextGathererService.ts` fetches it from the already-queried `crmContact` record; `aiReplyService.ts`'s two `resolveNameEvidence()` call sites both pass it through.
- `CrmContactRepository.update()` gained the write path (`manualDisplayName?: string | null | undefined` - undefined leaves it alone, null clears it back to automatic resolution); `LeadRepository`'s two contact-joined queries (`listByBusiness`, `listCreatedSince`) now also select it, so a lead's displayed name is consistent with its underlying CRM contact.
- New `PATCH /api/workspace/crm-contacts/:id` field (`manualDisplayName`, same optional/nullable pattern as the existing `email` field) and a real UI: a "Confirmed name" input on the CRM contact detail view, positioned right after the existing (Section 66) read-only Identity Sources panel, with a plain-language explanation of what it overrides.

**Verified**: 2 new `identityEngine.test.ts` cases (staff-confirmed outranks preferred name; blank staff-confirmed falls through), 1 new `displayName.test.ts` case, 2 new `crmAndLeads.test.ts` cases (set-and-flows-into-list-view; omit-leaves-untouched/null-clears). All 56 tests across the 5 directly-touched files pass, plus 49 in `aiContextGathererService.test.ts`/`aiReplyService.test.ts` (the two files whose `resolveNameEvidence`/`contactNameSources` call sites changed) unaffected. Typecheck clean both sides.

**Deliberately scoped out for now** (same reasoning as Section 66's own note): `resolveDisplayName()`'s three other call sites in `workspaceService.ts` - call history, status publisher, and group-message sender labels - resolve a name purely from `WhatsAppContactRepository`, with no CRM contact join at all. Wiring the manual override into those too would mean a new per-row CRM lookup each caller doesn't currently make, a real added cost for three surfaces where a customer's *conversation* name (not the CRM record) is what's actually being labeled. Left as a follow-up, not silently inconsistent by omission.

## Section 72 — Billing preservation / trial expiry (real, significant gap found and fixed)

**Real gap found**, discovered while re-examining Section 34-40's own earlier fix: the AI cost-control gate had been deliberately made to exempt `NO_ACTIVE_SUBSCRIPTION` from blocking, to avoid breaking pre-existing tests that use a bare business fixture. Investigating *why* those tests never needed a subscription led to a much bigger discovery: **a trial subscription never actually expires in this codebase**. `subscriptions.trial_ends_at` is set correctly at signup (both `trialOnboardingService.ts`'s real 48-hour public trial flow and `businessBootstrapService.ts`'s 14-day interim bootstrap) and even displayed back to the business (`getBillingOverview`'s `subscription.trialEndsAt`) - but nothing anywhere ever reads it back to actually enforce it. A `TRIALING` subscription sits in that status forever, and since `TRIALING` is one of `LIVE_SUBSCRIPTION_STATUSES`, `EntitlementService`'s entire enforcement stack (agent limits, WhatsApp accounts, campaigns, funnels, documents, and this session's own new AI token budget) stays permanently open for a business that never once paid, well past its own advertised "48-hour free trial." Separately, an older, fully-dead first-draft mechanism for this (`trialPolicy.ts`'s `canUseProductAccount()`/`TrialState`) has zero callers and zero test coverage anywhere in the codebase - superseded by the subscriptions-based approach but never removed.

**Fix**:
- `SubscriptionRepository.findExpiredTrials()` - every `TRIALING` subscription whose `trial_ends_at` has already passed.
- New `subscriptionExpiryService.ts` (`sweepExpiredTrials()`) - transitions each to `EXPIRED`, records a real `TRIAL_EXPIRED` `subscription_events` row, and notifies every active business member (reusing the existing `PAYMENT_ISSUE` notification type - no schema change needed).
- New `trial-expiry-sweep` scheduled job (15-minute interval, same `upsertJobScheduler` pattern as the other 11 real sweeps already running) registered in `incomingMessagesWorker.ts`.
- `aiOrchestrator.ts`'s cost-control gate now blocks on `NO_ACTIVE_SUBSCRIPTION` too, consistent with every other entitlement check - the earlier exemption is reverted now that the actual reason it was needed (trials never expiring, so the block was never legitimately reachable) is understood and fixed at the source instead of routed around.
- Fixed the two pre-existing test fixtures (`aiReliabilityPhase3B.test.ts`'s two `setupBusinessWithAgent()` helpers) that relied on a bare `createTestBusiness()` with no subscription - a shape that never occurs in production, where every business gets one the moment it exists.

**Verified**: 3 new `findExpiredTrials()` cases in `plansAndSubscriptions.test.ts`, 6 new cases in `subscriptionExpiryService.test.ts` (transitions/leaves-alone/records-event/notifies/never-touches-already-converted/tenant-isolation), 1 new `aiOrchestratorBudgetGate.test.ts` case confirming the restored block. All 55 tests across the 4 directly-touched files pass, including `aiReliabilityPhase3B.test.ts`'s full 37-test suite with the fixture fix. Typecheck clean both sides.

**Correction, found while doing the trialPolicy.ts cleanup this same session**: the original "a trial subscription never actually expires in this codebase" framing above overstated the gap. A *second*, older access-control layer already enforces trial expiry for real, and does so correctly: `productAccountService.ts`'s `getAccountAccessForMember()` calls `trialPolicy.ts`'s `deriveTrialState()` on every real access check, flips a lapsed trial's `product_accounts.status` to `RESTRICTED`, and `authMiddleware.ts` returns a real `402 PRODUCT_ACCESS_RESTRICTED` for it - this has been live the whole time for anything a staff member does through the web dashboard (`requireWorkspaceContext`-gated routes). What this section's fix actually closes is narrower but still real: that HTTP-level gate never runs for the AI-reply pipeline, which is driven by a BullMQ worker processing inbound WhatsApp messages with no request/session/auth middleware in the path at all - `EntitlementService`'s subscription-based checks are the only gate that code path can ever go through, and *those* genuinely never enforced trial expiry before this fix. So: dashboard access was already correctly cut off for an expired trial; free AI replies (and any other subscription/entitlement-gated action reachable from a background worker rather than an HTTP route) were not, until this fix. `trialPolicy.ts`'s `canUseProductAccount()` turned out to be a separate, genuinely dead function within that same file - the real enforcement logic (`getAccountAccessForMember`) was reimplemented inline rather than calling it - removed in this same pass along with its 2 dedicated test cases in `trialPolicy.test.ts` (3 unrelated tests for `normalizeTrialEmail`/`createTrialTiming`/`deriveTrialState` - all genuinely live - kept). Full backend typecheck clean after the removal.

## Section 13 — Conversational memory (formally verified; real gap found and fixed)

**Formally verified** (previously left as "substantially covered, not re-verified" - this closes that out): `customer_memory` (migration 959) is real, write-through, and already load-bearing - `conversationStateWriter.ts`'s `applyCustomerMemoryUpdate()` merges every `confirmFacts` entry the AI records into the customer's durable, cross-conversation memory (never just the one conversation's own `conversation_states` row), and `aiReplyService.ts` reads it straight back into the prompt as "Known facts about this customer from earlier conversations" on every subsequent reply, in any conversation, forever. Optimistic-concurrency retries, tenant isolation, and the full write-then-resurface round trip were already covered by 12 existing tests in `customerMemory.test.ts` before this pass touched anything.

**Real gap found**: none of that was ever visible to a human. Staff had no way to see what the AI actually remembers about a returning customer across their conversation history - the exact same shape of gap Section 66 closed for identity sources (verified/push/business name), just for durable cross-conversation facts instead of name evidence.

**Fix**: `WorkspaceService.getCrmContactMemory(businessId, crmContactId)` - resolves the CRM contact's linked WhatsApp contact to a real customer identity (`CustomerIdentityRepository.findCustomerIdByIdentity`), then reads `customer_memory` for it; returns a null `customerId` (not an error) for a contact never resolved to a customer, and empty facts (not an error) for a real customer with no memory row yet - same "honest absence, never fabricated" pattern as everywhere else in this codebase. New `GET /api/workspace/crm-contacts/:id/memory` route. New read-only "What the AI remembers (across all conversations)" panel on the CRM contact detail view, fetched on demand per contact (a second real query beyond `listCrmContacts`, so never preloaded for the whole list).

**Verified**: 5 new tests in `workspaceServiceCrm.test.ts` (resolves real facts / null customerId for an unresolved contact / empty facts for a resolved customer with no memory yet / cross-tenant 404 / tenant isolation on a same-shaped lookup). All 24 tests across the 2 touched files pass. Typecheck clean both sides.

## Section 60-62 — Property ops strengthening (real, significant gap found and fixed)

**Real gap found**, same shape as Section 56's original discovery: `PropertyOperationsRepository` has real, live `createIncident()`/`createWorkOrder()` (called from `maintenanceWorkOrderExecutor.ts` and `propertyOperationsService.ts`'s `intakeMaintenance()`, both real production paths triggered from actual guest/tenant WhatsApp conversations) - but of its 18 methods, not one was ever an UPDATE. Every incident created stayed `OPEN` forever; every work order stayed `PENDING_APPROVAL` forever, no matter what actually happened with the vendor in real life. `PropertyOperationsPage.tsx` (1006 lines, a genuinely real, wired-up dashboard - not a mockup) already had a full Incidents tab showing both, complete with a `StatusBadge` component that already anticipated `RESOLVED`/`CLOSED`/`APPROVED`/`COMPLETED` as real values - but zero buttons anywhere to ever reach them. An incident reported at 2am about a broken AC stays "OPEN" in the dashboard forever, even after a vendor fixes it, because there was no code path that could ever change that.

**Fix**:
- `PropertyOperationsRepository.updateIncidentStatus()` - transitions `OPEN → ESCALATED/RESOLVED/CLOSED`, optionally assigns a vendor in the same call, stamps `resolved_at` once for a terminal status (never overwritten by a later call to the same terminal status - same "advances forward only" reasoning as Section 56's `markCompleted`).
- `PropertyOperationsRepository.updateWorkOrder()` - each field (`status`, `vendorId`, `approvedCostCents`, `scheduledFor`, `completionNotes`) is independently optional, so approving a cost and later recording completion are two separate, real calls that never have to guess or re-send the other's current value; `completed_at` stamps once, same as `resolved_at`.
- New `PATCH /api/property-operations/incidents/:id` and `PATCH /api/property-operations/work-orders/:id` routes, same `requirePermission('property.manage')` gate every other mutation on this router already uses.
- Real UI: "Mark resolved"/"Close" buttons on the incident detail panel; a new `WorkOrderCard` component with "Approve" (optional real cost input), "Mark completed" (optional notes), and "Cancel" - the first actionable controls this page has ever had for either table.

**Verified**: 8 new tests in `propertyOperationsLifecycle.test.ts` (resolved_at stamps once/never for non-terminal status/vendor-assign-with-status-change/cross-tenant 404 for incidents; approve-then-complete-preserves-earlier-field/undefined-means-untouched/completed_at-stamps-once/cross-tenant 404 for work orders), all passing alongside the existing 6-test `maintenanceWorkOrderExecutor.test.ts` suite. Typecheck clean both sides.

## Section checklist

```
[X] 01      - Repository and architecture audit
[X] 02      - Existing feature inventory
[X] 03      - Unified agent intelligence architecture - ALREADY IMPLEMENTED, VERIFIED
[~] 04      - Conversational intelligence engine - first pipeline stage shipped (intent/entity/risk classifier)
[ ] 05      - Human-like conversation
[X] 06      - Invisible conversational funnel - funnel_stage field, verified
[ ] 07      - Progressive information discovery
[ ] 08      - Question priority engine
[X] 09      - Next-best-action engine - extended real engine with a 6th signal, verified
[X] 10      - Customer readiness - customer_readiness field, verified
[ ] 11      - Lead qualification
[X] 12      - CRM funnel UI bug - FIXED (pipelineStages.ts), verified
[X] 13      - Conversational memory - formally verified: real, working, cross-conversation write-through since migration 959; real gap found (never surfaced to staff) and fixed, verified
[~] 14-24   - Identity & Name Discovery Engine - within-conversation resolution + usage/repetition + manual contact-name UI (23) shipped and verified; cross-conversation carry-over (20), "important moment" cooldown override (19) still deferred
[X] 25      - Chat sync incremental resume - real bug found and fixed, verified
[X] 26      - Message delivery status reconciliation - real bug found and fixed (see notes), verified
[ ] 27-30   - Campaign attachments, private storage, storage limits, AI content generator
[ ] 31-33   - Marketing research, timing engine, contact availability intelligence
[~] 34-40   - Token economy, budgets, display, cost control - real gap found and fixed, verified; approval/override flow and deeper analytics deferred
[!] 41-42   - Autonomous operations modes / work loop - BLOCKED, APPROVAL REQUIRED (product-policy decision, see approval queue)
[~] 43-44   - Best-recommendation engine (not yet touched); work queue states - real gap found (a FAILED execution's notification claimed "approved") and fixed, verified
[X] 45      - Approval Centre - real gap found (unreachable by 8/11 verticals) and fixed, verified
[X] 46-47   - Approval policy, risk engine - real gap found (a stale-approved meeting booking would silently create a real event for a passed time) and fixed, verified
[X] 48      - Autonomous Morning Briefing - real aggregation, verified
[X] 49      - Emergency controls (kill switches) - per-agent/per-conversation already real and complete; real gap found in campaign mid-send stop and fixed, verified
[ ] 50-55   - Agent builder, personas, permissions, 3-min setup, sliders, business-specific agents
[X] 57-59   - Zoom/Google booking + AI booking agent - real gap found (dead OAuth connection failed silently, no staff notification) and fixed, verified
[~] 60-62   - Property ops strengthening - real gap found and fixed (incident/work order lifecycle), verified; task/productivity intelligence, smart scheduling still open
[ ] 63-65   - MCP/tool architecture, AI safety, prompt injection defence
[X] 66      - CRM identity profile fields on the contact view - real gap found (source fields queried but discarded) and fixed, verified
[X] 56      - Appointment System - real lifecycle mutation + completion sweep + dedicated page built (none existed before), verified
[X] 67      - CRM Data Export - real CSV/JSON export, verified
[ ] 68      - Analytics
[~] 69,70,72 - Observability, webhook reliability; 72 (billing preservation/trial expiry) - real gap found and fixed, verified
[X] 71      - Queue reliability - real gap found (documentParseWorker's retry guard silently masked a permanently stuck document) and fixed with a staleness sweep, verified
[!] 73-74   - Real payment architecture (Barbados) - APPROVAL REQUIRED (provider selection), Email config hardening
[ ] 75-91   - Data privacy, minimisation, memory architecture, retention, learning, privacy/probing engine
[ ] 93,94,96,97,98 - Security model, global dashboard, AI provider mgmt, resource/cost mgmt, agent teamwork, failure handling
[X] 92      - Loop protection - agent/tool-call loops already solid; real gap found in funnel CONDITION cycles and fixed, verified
[ ] 99-101  - Testing, adversarial testing, performance
[ ] 102-104 - DB/migrations, API contracts, frontend experience
[ ] 105-109 - Feature discovery, mobile-first, notification intelligence, morning experience
[ ] 110-113 - Business automation wiring, follow-up intelligence, conversational fatigue, customer effort
[ ] 114-116 - Ethical funnel, campaign ethics, audit logging
[ ] 117-122 - Security audit, deployment, env config, integration health centre, approval isolation, final approval queue
[ ] 123-129 - Final full system test, regression, data integrity, hallucination verification, UX/perf/security reviews
[ ] 130-134 - Documentation, final report, final memory entry, final principle

Also requested directly by you outside the numbered sections:
[X] Status comments/replies threading (Marketing → Status tab) - real reply detection + UI, built and verified (see notes)
[ ] whatsmeow-main.zip review (possible Baileys alternative) - flagged earlier, not yet done
```

---

## How we're actually going to run this

Given the real scope above, I'm going to work this in focused batches per session rather than silently grinding through all 135 in the background:

1. I'll pick the next unblocked section(s), do the real inspect→implement→test→verify cycle, update this file, and give you a short real status — not a wall of "done" claims.
2. Anything security-critical or spending real money still gets a checkpoint with you first, even where the directive says not to ask.
3. Section 12 (CRM funnel bug) is blocked on you pointing me at the actual screen — I found the CRM pipeline UI but nothing matching "arrow brings back completed options."

What do you want me to pick up next — Section 03 (unified agent intelligence architecture, which a lot of the later sections depend on), or do you want to first tell me where the Section 12 bug actually lives so I can fix that concrete, reported issue?
