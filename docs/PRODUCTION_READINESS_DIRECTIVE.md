# Production Readiness Directive (corrected)

This replaces the 31-section "Master Engineering Directive" the user
pasted on 2026-08-21. That document's *governing principle* (adapters,
feature flags, kill switches, never replace a working system to introduce
a framework) is correct and is kept below. Its *phase list* was written
without visibility into this repository's actual state and describes a
large amount of work as "future" that is already built, plus a few
specific technical claims (a "463" HTTP status code, a "deaf session
detector," a "reachout timelock guard") that do not correspond to
anything in WhatsApp's protocol, Baileys, or this codebase and should be
treated as unverified until a primary source is found for them.

This document is the corrected baseline: what's actually still open,
ordered by (a) how confident we are the gap is real, (b) how directly it
affects production-readiness. See `CHANGELOG_SECURITY.md` for the
authoritative, per-commit record of everything already shipped, and
`PRODUCTION_AUDIT.md` for the last full audit roll-up (predates
Phases 5-7 and the DSPy service below; treat this document as superseding
it for planning purposes).

## Governing principle (kept, unchanged)

- Preserve what works. Never rewrite a working component to introduce a
  framework.
- Extend through adapters and feature flags, defaulted off, with a real
  fallback path if the new thing fails.
- Never build new infrastructure (a new external service, a new runtime
  abstraction with only one real implementation) without a demonstrated
  need - a "might be useful later" is not a demonstrated need.
- Every claim of "done" is checked against real tests, a real build, or a
  real running process - never asserted from reading code alone.

## Already implemented - do not re-build

Verified against actual source/tests in this session, each with its own
`CHANGELOG_SECURITY.md` entry:

| Capability | Where |
|---|---|
| Contact/chat display-name resolution (best-available identity, never a raw line ID) | `src/domain/whatsapp/displayName.ts`, `src/web/src/lib/identity.ts` |
| Live TimeService (UTC-internal, business/user timezone, DST, manual override, a real AI tool) | `src/services/time/` |
| Actor/tenant-aware AI tool authorization, SYSTEM-tier deny, rate limiting, audited denials | `src/services/ai/agentGuard.ts`, `aiToolPolicy.ts` |
| Centralized AI decision path (routing + context + reply, one entry point) | `src/services/ai/aiOrchestrator.ts` |
| Knowledge base / RAG (Postgres full-text search, business-scoped) | `src/services/knowledgeBaseService.ts`, `knowledgeBaseSearchService.ts` |
| Multimodal AI (real image/audio/video/PDF bytes to Gemini, honest fallback text) | `src/services/ai/mediaContext.ts`, `aiReplyService.ts` |
| DSPy prompt optimization, as a genuinely separate offline service with a human-approval-only interface | `services/prompt-optimizer/`, `src/services/ai/promptOptimizationService.ts` |
| Funnel deletion lifecycle (refuses while active instances exist, audited) | `src/services/funnelService.ts` |
| Campaign lifecycle (dispatch-failure handling, notifications, no silent stuck-`RUNNING` state) | `src/services/campaignService.ts` |
| Circuit breaker on the Gemini call, Goose failover | `src/services/aiCircuitBreaker.ts`, `gooseService.ts` |
| Failure-injection-tested Postgres/Redis outage handling on the request path | `src/queue/enqueueWithTimeout.ts` (2 of 6 producers - see gap below) |
| Container hardening (non-root, cap-drop, resource limits) | `Dockerfile`, `docker-compose.yml` - real boot verified once, not since Phase 2 |

## Closed since this document was written

Priorities 1-4 below are now done - each with its own `CHANGELOG_SECURITY.md`
entry, real tests, and a passing full suite at the time it landed:

1. **Context Trust Builder** - `<untrusted_data>` boundaries now wrap CRM
   notes and knowledge-base excerpts in `aiReplyService.ts`, with a
   boundary-forging-attempt escape and an explicit rule telling the model
   what the boundary means. `IMPLEMENTED AND VERIFIED`.
2. **Funnel stale-instance reconciliation sweep** - migration 059 added
   `funnel_instances.resume_at`; `sweepStaleFunnelInstances()` reconciles
   an instance whose delayed job never fired, never touches one still
   genuinely waiting. `IMPLEMENTED AND VERIFIED`.
3. **Phase 18: scheduled security scans** - `securityScanService.ts`
   scans `security_audit_logs` for repeated `lock_unlock_failure`/
   `ai_tool_denied` and raises a real, cooldown-deduped `SECURITY_ALERT`
   notification. `IMPLEMENTED AND VERIFIED`.
4. **`enqueueWithTimeout` on the remaining producers** - turned out to be
   a real correction, not just uniformity: three of the four "off the
   request path" producers were actually awaited by real HTTP routes
   (`scheduleStatus`, `approveAndSend`, all three revocation functions).
   All six remaining call sites now wrapped. `IMPLEMENTED AND VERIFIED`.

## Real, currently-open gaps - this is the actual remaining backlog

Ordered by priority. "Confidence" reflects whether this was independently
found and verified in this codebase (`high`) vs. carried over from the
pasted directive without our own verification (`unverified`).

1. **Fencing tokens for BullMQ worker execution** (execution_id/lease_id/
   monotonic token validated inside the Postgres transaction) -
   *confidence: legitimate pattern (this is the standard
   distributed-systems technique for exactly this problem), but no
   demonstrated failure mode in this codebase's own failure-injection
   testing (Phase 19) or production audit*. Real BullMQ jobs already have
   at-least-once delivery + idempotency keys on the one path that
   actually re-sends (`ai-reply:${messageId}`) - not the same guarantee,
   but no observed gap it would have caught. **Watch item, not scheduled
   work** - build if a real duplicate-mutation incident is ever observed,
   not speculatively.
2. **Docker container re-verification** - real gap, but *not something
   this sandbox can close*: Docker Hub pulls are blocked by this
   environment's egress policy (hit repeatedly since Phase 1). Every
   phase since the one verified boot has been typechecked/tested/built
   natively, never re-booted in a real container. Stays documented as an
   open risk until run in an environment with real registry access.
3. **OpenClaw Cell Runtime integration** (formerly "OpenClaw Fleet
   integration" - renamed for a real reason, see below) - *decided and
   in progress, on its own branch*: one isolated OpenClaw instance per
   tenant, pinned version + digest (obtained from the real GHCR
   registry, never invented), a Security Watcher that can quarantine a
   cell, and OpenClaw treated as a permanently untrusted execution
   environment mediated through a dedicated Tool Gateway - never trusted
   with authorization itself, and never routed through the same
   `agentGuard.ts`/`aiToolPolicy.ts` the live Gemini path uses. Four
   slices landed on `phase-2-ai-repair` (see `CHANGELOG_SECURITY.md`'s
   four 2026-08-21 "OpenClaw" entries), then a critical real-environment
   finding required a fifth, architecture-level pivot, done on its own
   branch (`openclaw-cell-runtime`, split at commit `02add1a`) rather
   than touching the working, deployed branch mid-rearchitecture:

   **The pivot (2026-08-22):** the user personally ran real verification
   on their own machine - a genuinely installed `openclaw@2026.7.1-2`
   (the exact pinned version) - and found `openclaw fleet --help`
   returns "Unknown command: openclaw fleet." **Fleet does not exist in
   any released, stable OpenClaw version.** `docs/cli/fleet.md`, the
   source every prior OpenClaw slice was built against, had been read
   from the `openclaw/openclaw` repo's `main` branch HEAD - already
   ahead on the in-development, beta-only `2026.8.1` line - not the
   actual tagged release being pinned. Full detail, including the exact
   real terminal output and the two adjacent-but-different real commands
   that exist instead (`sandbox`: internal per-agent tool sandboxing,
   not multi-tenant orchestration; `nodes`: paired-device management,
   unrelated to SaaS tenancy), is in `CHANGELOG_SECURITY.md`'s
   2026-08-22 "OpenClaw Cell Runtime" entry.

   Decision: build the per-tenant orchestration directly on Docker +
   the stable `openclaw gateway run` command, behind a clean
   `OpenClawCellRuntime` interface (`DockerCellRuntime` implemented now;
   a future `FleetCellRuntime` can implement the same interface once
   OpenClaw ships Fleet stable, without touching anything else). All
   "fleet" naming in the schema and code was renamed to neutral "cell"
   naming (migration 065) rather than silently keeping misleading names.

   1. Mapping table (`openclaw_cells`) + `OpenClawCellService`, now
      runtime-agnostic. `IMPLEMENTED BUT NOT FULLY VERIFIED` - no real
      `docker run` of the exact command/env combination has been
      attempted yet, though the user's own machine now has the real
      pinned image pulled and a working `openclaw` CLI installed, ready
      for that next step.
   2. `openclawSecurityWatcherService.ts` - unchanged in behavior,
      updated only for the cell-naming rename. `IMPLEMENTED BUT NOT
      FULLY VERIFIED` (no live `api.github.com` access from this
      sandbox).
   3. `openclawToolGateway.ts` + `entityOwnershipRegistry.ts` - the full
      authorization pipeline protecting the first and only WRITE-tier
      OpenClaw tool, `update_lead` (scoped to `status`/`stage`/`notes`).
      `IMPLEMENTED AND VERIFIED` for the authorization logic itself (15
      tests, all real Postgres outcomes matching an explicit adversarial
      acceptance table); still not verified end-to-end since no real
      OpenClaw cell has ever called it.
   4. `openclawAdapterService.ts`/`openclawAdapterRouter.ts` - the HTTP
      seam a real cell would call (`POST /api/openclaw/tools/invoke`).
      `IMPLEMENTED AND VERIFIED` for the adapter's own logic, including
      a test proving a stolen valid token from another tenant is denied
      by the gateway when used against this tenant's real entity/chat
      IDs - a real cross-tenant business-logic DENY, not just an HTTP
      auth failure.
   5. `openclawCellRuntime.ts`/`dockerCellRuntime.ts` - the new
      per-tenant orchestration layer, replacing the nonexistent Fleet
      CLI wrapper. Real hardening profile (cap-drop/no-new-privileges/
      pids-limit/mem/cpus/read-only-rootfs/loopback-only-publish/
      per-cell-network), real `/healthz` health gating. **Real-runtime
      verified 2026-08-22** against a live, disposable cell on the
      user's machine - see `CHANGELOG_SECURITY.md`'s "real
      DockerCellRuntime verification" entry for the full raw evidence.
      Auth enforcement, hardening, and resource limits: `VERIFIED`. A
      real restart-timing bug in `start()` was found (deterministic,
      not intermittent - real boot-to-`ready` time is 5.1-5.8s against
      a hardcoded 5s post-restart health-check cap) and fixed (restart
      now uses the same configured deadline `create()` gets, no new
      magic constant). The fix was re-run for real: 3 consecutive
      stop/start cycles on a live container, all three succeeding
      within the deadline (`elapsed_ms` 19047/24814/23359 - slower than
      the original 5-6s boot observation, consistent with host-load
      variance, and itself evidence for why the fix gives `start()` the
      full budget rather than a short cap). Restart lifecycle:
      `VERIFIED`.

   **Egress containment (2026-08-22, separate from the timing fix
   above):** the original hardening requirement list included "minimal
   outbound access" - never actually implemented until now. Per-cell
   networks now use Docker's `--internal` flag (no default outbound
   route at all). Re-verified for real against a live container:
   general-internet egress genuinely blocked (`curl` exit 6/7 against
   `example.com`/`1.1.1.1`) and cross-cell isolation genuinely enforced
   (`curl` exit 6 from one cell's container to another's IP) - both
   `VERIFIED`.

   That same re-test surfaced a real, confirmed side effect: `--internal`
   also excludes the network from the NAT/forwarding plumbing `--publish`
   needs, so `create()` reliably failed its health gate even though the
   Gateway itself booted cleanly (`docker exec` into the container showed
   a real `200 OK` from `/healthz`; the host-side published-port request
   got `curl: (7) Could not connect`). Fixed by moving health checking
   (`create()`/`status()`/`start()`) onto `docker exec`-based checks run
   inside the container's own namespace, which never crosses that
   boundary. Per the user's explicit decision, `--publish`/
   `gatewayEndpoint`/`port` are kept as-is - not removed - reserved as
   transport metadata for a possible future authenticated Gateway path,
   deliberately decoupled from health checking rather than conflating the
   two. **This fix has been verified against the mocked test suite only
   (589/589, typecheck clean) - not yet re-run against a real container**;
   that re-run is the immediate next step. Host-gateway reachability
   (`host.docker.internal`) itself also remains unverified - deprioritized
   in favor of the health-check fix, to be revisited.

   Explicitly still gates the next item: no provider credential (OpenAI,
   Gemini, or otherwise) is to be placed in a cell until all of the above
   is verified for real.

   **Also reconfirmed this pass, independent of the Fleet finding:**
   this sandbox genuinely runs a Docker daemon; what actually blocks
   image pulls here is narrower - both Docker Hub and GHCR redirect blob
   downloads to CDN domains (`production.cloudfront.docker.com`,
   `pkg-containers.githubusercontent.com`) outside this sandbox's egress
   allowlist, confirmed via a real `dockerd` start + real `docker pull`
   attempts that resolved the manifest/auth but failed at the blob
   layer. The user's own machine does not have this restriction - real
   pull, real digest match, confirmed via raw `docker images --digests`/
   `docker inspect` output.

   Remaining, in order: (1) implement `purgeData`'s state-directory
   deletion with real containment checks (currently an explicit no-op
   with a logged warning, not silently skipped); (2) encrypted
   Gateway-token storage; (3) research OpenClaw's real mechanism for
   pointing its own agent/tool-calling loop at an external webhook
   (genuinely unresearched - do not guess at a config format; a real
   boot log from this pass shows the gateway has its own independent
   agent/model capability defaulting to `openai/gpt-5.5`, never
   exercised, worth investigating as part of this item); (4) OpenClaw
   behind a feature flag, tenant-allowlisted, only after all of the
   above - the existing Gemini/Baileys path on `phase-2-ai-repair`
   remains completely untouched throughout.
4. **OpenPanel** - *deferred, needs a scoping answer*: operator-facing
   internal analytics, or customer-facing analytics for tenants? Different
   answers imply different event schemas and access control. Not started.
5. **Apache Cloudberry** - *deferred, real over-engineering risk*: a
   distributed MPP data warehouse is a materially bigger commitment than
   anything else on this list. Should not be stood up without a named
   analytical problem it solves that Postgres genuinely cannot. Not
   started.
6. **"Pic Smaller"** - *unidentified*: no repository URL has been
   provided; cannot evaluate or plan against it.

## Explicitly not adopted from the pasted directive

- The Baileys "deaf session detector," "reachout timelock guard," and
  "463"-status-code slow-start behavior - unverified, does not match any
  real Baileys/WhatsApp signal found in research so far. If there is a
  real source for these (a specific WhatsApp rate-limit behavior actually
  observed), it should be cited before any of this is built - not
  implemented from an unsourced description.
- Weighted fair queuing across message priority tiers, tiered analytics
  (Postgres outbox + Redis Streams with MAXLEN) - real, standard patterns,
  but no demonstrated need yet (no OpenPanel consumer for the analytics
  tiering; no observed campaign-starves-operational-message incident for
  WFQ). Revisit once OpenPanel is actually scoped/built, not before.
- A full 31-section prompt re-auditing the entire repository from
  scratch - this document is that audit, already done, and should be
  handed to any future session instead of the original.
