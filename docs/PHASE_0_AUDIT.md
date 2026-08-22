# Phase 0 Audit — Repository & Tenant-Isolation Sweep

Status: **read-only audit. No code changed. No fixes applied.** Per the
directive this audit was run under: *"Do not fix unrelated issues. Report
findings before implementation... Begin with PHASE 0 AUDIT ONLY. Do not
implement anything until the audit and architecture review are complete."*

This supersedes nothing in `BUSINESS_EXECUTION_CONTEXT.md` (Phase 2B) or
`PHASE_2C_DOCUMENT_ARCHITECTURE_PROPOSAL.md` (Phase 2C) — it extends that
audit to the specific sweep this phase asked for: every bare/unscoped
`findById`, every global search, every place `businessId`/`userId` could
originate from something other than the authenticated session, and every
CRM/message/media/storage lookup not already covered by Phase 1.

## 1. Method

`grep -rn '\.findById(' src` (20 repository files, 29 call sites), read in
full alongside every repository that defines a bare `findById`, cross-
referenced against Phase 1's already-migrated list (`whatsappMediaRepository`,
`whatsappChatRepository`, `whatsappMessageRepository`, `aiAgentRepository`,
`teamRepository`, `businessMembershipRepository`, `notificationRepository`,
plus the dead `crmContactRepository.findById` removal). Every call site
below is a repository/table **not** in that list.

## 2. Audit table

| Data | Owner | Business scoped? | User scoped? | Customer scoped? | AI access? | Who may write? | Who may read? | How ownership is enforced | Adversarial test? |
|---|---|---|---|---|---|---|---|---|---|
| `businesses` | tenant root | n/a (is the tenant) | — | — | Read-only (`get_current_time`, `guardToolInvocation`'s own lookup) | Registration flow only | Any authenticated member; AI reads for context (`aiContextGathererService.ts:53`, `timeService.ts:68`, `agentGuard.ts:121`) — all take an already-authenticated `businessId`, never a client-supplied one | Session/token-derived `businessId`, never a request field (Phase 2B, section 1) | Yes — Phase 2B/OpenClaw suite |
| `leads` | business | **Partial — see finding L1** | — | indirectly, via `crm_contacts` | Yes, via `update_lead` (only live AI write tool) | `openclawToolGateway.ts` (AI, post-authorization), `workspaceService`/CRM UI | Business members; AI, scoped by `EntityOwnershipRegistry` | `update()`/`updateStatusForBusiness()` take `businessId` in the `WHERE`; but `findById()` (used internally post-authorization) and `updateStatus()` do not | Yes for the write path (`openclawToolGateway.test.ts`); no test targets `execute()`'s internal `findById` in isolation (see finding L1) |
| `email_messages` | business | **Partial — see finding E1** | — | recipient, not a tenant | No AI write access (drafts only, human `approveAndSend`) | `emailService.ts` (human-gated `approveAndSend`), `funnelService.ts` (funnel drafts) | Business members via `findByIdForBusiness` at every human-facing call site | `findByIdForBusiness(businessId, id)` used everywhere a human/API request supplies the id; the worker's own re-fetch uses bare `findById` (finding E1) | No — this exact path has no adversarial test today |
| `whatsapp_outbound_messages` | business | **Partial — see finding O1** | — | recipient chat | No | `whatsappOutboundMessageService.send()` (already scoped, Phase 1) | Business members, via manual post-fetch check at the one HTTP read endpoint | `GET /api/workspace/outbound-messages/:id` does bare `findById` + manual `outboundMessage.businessId !== businessId` check → 404 (functionally closed, structurally pre-Phase-1 pattern) | No dedicated test; relies on the manual check being read correctly |
| `scheduled_statuses` | business | Yes (background-worker pattern) | — | — | No | `statusService`-equivalent (human/API), scoped | `scheduledStatusPublishWorker.ts`/`messageRevocationWorker.ts` re-fetch by bare `findById(scheduledStatusId)` — job data carries only the id, no `businessId` field exists on the job at all | n/a — id is only ever enqueued by already-scoped code |
| `ai_agent_prompt_optimizations`, `plans`, `sessions`, `subscriptions`, `whatsapp_sync_jobs`, `whatsapp_accounts`, `whatsapp_contacts`, `whatsapp_groups`, `users` | mixed (business or user) | Yes, functionally | Yes where applicable | — | No direct AI access | Existing services only | Existing services only | Every bare `findById` call site for these (grepped above) is reached only after the caller already resolved the parent entity in-scope (e.g. `chat.contactId` from an already-scoped chat, `subscription.planId` from an already-scoped subscription, `session.userId` from a cookie-derived session id) — none accept an externally-supplied id without a prior scoped lookup in the same call chain | Not newly tested this phase; no new finding |

Everything **not** listed above (documents, storage connectors, embeddings,
Writing Twin data) does not exist in the codebase yet — there is nothing to
audit; Phase 2C's proposal already covers the design requirements for that
layer and remains unimplemented.

## 3. Findings

### Finding L1 — `openclawToolGateway.ts` `execute()` re-fetches leads unscoped (low risk, defense-in-depth gap)

`private async execute(toolName, businessId, leadId, fields)` (lines
203–224) calls `this.leadRepo.findById(leadId)` twice (lines 205, 222) with
no `businessId` check inside `execute()` itself.

**Why this is not exploitable today:** `execute()` is private and has
exactly one caller, `invoke()`, which calls
`this.ownershipRegistry.resolve(policy.entityType, input.businessId,
input.chatId, input.entityId)` at line 173 — and only reaches `execute()`
at line 179 if that resolution succeeds. `EntityOwnershipRegistry`'s
`LeadOwnershipResolver.resolve()` (`entityOwnershipRegistry.ts:38`) already
does `leadRepo.findById(entityId)` itself and rejects on
`lead.businessId !== businessId` (confirmed correct in Phase 2B). So by the
time `execute()` runs, the lead has already been proven to belong to
`businessId` once. This is genuinely safe by call-chain construction today,
verified fresh, not assumed.

**Why it is still worth flagging:** `execute()` re-derives nothing from
that verified result — it just re-trusts the same `leadId` a second time.
A future change (a new tool added to the policy map with its own
`execute()` branch, or any refactor that calls `execute()` from a second
path) would silently inherit an unscoped lookup with no compiler or test
signal. `leadRepository.ts` also has **no `findByIdForBusiness` method at
all** — it is the one repository in the Phase 1 list's spirit that was
never given the scoped variant, because Phase 1 was explicitly scoped to
the 8 repositories already named and leads were not on that list.

**Verdict: real, low-severity, structural gap — not a live cross-tenant
bug.** Left unfixed per this phase's explicit "report, don't fix" scope.

### Finding E1 — `emailSendWorker.ts` ignores the `businessId` already present in its own job payload

`EmailSendJobData` (`emailSendQueue.ts:6-9`) declares **both**
`emailMessageId: string` and `businessId: string`, and both enqueue sites
(`emailService.ts:203` inside `approveAndSend()`, and `:477` in the funnel
send path) populate `businessId` correctly from an already-scoped fetch
(`emailRepository.findByIdForBusiness(businessId, id)` at line 178 runs
*before* the job is ever enqueued).

But `processJob()` (`emailSendWorker.ts:24-26`) destructures only `{
emailMessageId }` from `job.data` — the `businessId` field is present on
every job and is never read. It then calls the bare, unscoped
`emailRepository.findById(emailMessageId)` (line 27).

**Why this is not exploitable today:** the only producer of this queue is
`enqueueEmailSend()`, called from exactly two places, both already scoped
before enqueue. There is no path today by which an `emailMessageId` for
Business A's email reaches this worker paired with Business B's
`businessId`, or vice versa, because nothing ever enqueues an unscoped or
attacker-supplied id.

**Why it is still worth flagging:** this is the one instance in the whole
sweep where the correct scoping value was already sitting unused right
next to the unscoped call — every other worker in this codebase
(`outboundDispatchWorker.ts`, `scheduledStatusPublishWorker.ts`,
`messageRevocationWorker.ts`) has an excuse (their job payload genuinely
carries only the entity id, not a `businessId`); this one does not. It is
also a trivial, mechanical, one-line fix
(`emailRepository.findByIdForBusiness(job.data.businessId, emailMessageId)`)
that would close the gap structurally rather than by caller discipline —
consistent with the Phase 1 policy already adopted for every other
repository.

**Verdict: real, low-severity, structural gap — not a live cross-tenant
bug. The cleanest, cheapest fix of anything found in this audit.**

### Finding O1 — `GET /api/workspace/outbound-messages/:id` uses the pre-Phase-1 pattern

`src/server/index.ts:823-828` does
`new WhatsAppOutboundMessageRepository(pool).findById(String(req.params.id
?? ''))` followed by a manual `if (!outboundMessage ||
outboundMessage.businessId !== businessId) return 404`. This is exactly
the "bare `find` + JavaScript ownership check" pattern Phase 1 set out to
eliminate everywhere — functionally correct and returns the required
indistinguishable-404, but `whatsappOutboundMessageRepository.ts` was not
one of the 8 repositories in Phase 1's approved list, so it was never
migrated to a `findByIdForBusiness`-shaped method, and this call site
(and the repository) still lack a real adversarial test proving the
cross-tenant 404.

**Verdict: real, low-severity, structural gap — functionally closed today,
not structurally enforced, not tested.**

### Non-findings (checked, confirmed clean)

- `businessRepository.findById` call sites (`funnelService.ts:257`,
  `workspaceService.ts:874`, `server/index.ts:1723`, `timeService.ts:68`,
  `agentGuard.ts:121`, `aiContextGathererService.ts:53`) all pass an
  already-authenticated `businessId` — there is no code path where a
  client, chat message, or AI-tool argument supplies this value directly
  (re-confirmed, matches Phase 2B's original finding).
- `userRepository.findById` (`authService.ts:166`, `workspaceMemberService.ts:110`)
  and `sessionRepository.findById` (`authService.ts:214`) are only ever
  called with a cookie-derived session's own `userId`/`sessionId` — no
  request field feeds either.
- `whatsappContactRepository.findById`/`whatsappAccountRepository.findById`
  call sites (`workspaceService.ts`, `profilePictureSyncService.ts`,
  `whatsappConnectionService.ts`, `whatsappSyncService.ts`) all receive an
  id sourced from an already-scoped parent row (a chat's own `contactId`,
  a sync job's own `whatsappAccountId`), never a bare external input.
- No global/unscoped *search* endpoint was found reaching across tenants —
  the one cross-entity search (`B13` global search) was already built
  business-scoped (pre-existing, outside this audit's new findings).
- No code path lets `userId` be supplied by the AI/model — confirmed via
  the same grep sweep; the only AI-writable entity remains `leads`
  through `update_lead`, which never takes a `userId` argument at all.

## 4. Summary for decision

Three real findings, all the same shape and severity: **structurally
unscoped internal re-fetches that are safe today only because every
current caller already enforces scope before reaching them** — not
currently exploitable, not covered by an adversarial test, and each one
inconsistent with the Phase 1 policy already adopted for the rest of the
codebase. Ranked by how cheap and unambiguous the fix would be:

1. **E1** (`emailSendWorker.ts`) — cheapest fix, most convincing case: the
   correct value already exists in the payload and is simply unused.
2. **O1** (`outbound-messages/:id` endpoint) — same shape as every
   Phase-1 repository before it was migrated; would just extend the
   already-established pattern to one more repository.
3. **L1** (`openclawToolGateway.ts` execute()) — lowest priority; already
   protected by a verified authorization pipeline one layer up, so this is
   pure defense-in-depth, not a live gap.

No fixes have been made. Per this phase's scope, this report is the
deliverable — awaiting direction on whether to close any of these three
now (and if so, which), defer them alongside the Phase 2C document work,
or leave them as documented, accepted, low-severity residual risk.
