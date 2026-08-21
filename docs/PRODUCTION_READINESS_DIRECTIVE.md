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
3. **OpenClaw Fleet integration** - *decided and in progress*: the user's
   finalized architecture is one isolated Fleet cell per tenant (never a
   shared Gateway), pinned version + digest (obtained from the real GHCR
   registry, never invented), a Security Watcher that can quarantine a
   cell, and OpenClaw treated as a permanently untrusted execution
   environment mediated through a dedicated Tool Gateway - never trusted
   with authorization itself, and never routed through the same
   `agentGuard.ts`/`aiToolPolicy.ts` the live Gemini path uses (a
   deliberate file-level isolation choice, not an oversight). Three
   slices landed so far (see `CHANGELOG_SECURITY.md`'s three 2026-08-21
   "OpenClaw" entries for full detail):
   1. Mapping table + `OpenClawFleetService` Fleet CLI lifecycle wrapper.
      `IMPLEMENTED BUT NOT FULLY VERIFIED` (no real Docker/Podman daemon
      in this sandbox).
   2. `openclawSecurityWatcherService.ts` - polls GitHub Security
      Advisories per deployed version, severity-only classification
      (never auto-clears SAFE, given OpenClaw's non-semver-compatible
      rebuild-revision versioning), auto-quarantines on CRITICAL, wired
      into the scheduler every 6 hours. `IMPLEMENTED BUT NOT FULLY
      VERIFIED` (no live `api.github.com` access from this sandbox).
   3. `openclawToolGateway.ts` + `entityOwnershipRegistry.ts` - the full
      authorization pipeline (idempotency/conflict detection, tenant and
      cell checks, fencing-generation check, rate limit, field/value
      validation, entity ownership) protecting the first and only
      WRITE-tier OpenClaw tool, `update_lead` (scoped to `status`/
      `stage`/`notes` - narrower than first proposed, see the changelog
      entry for the real schema reasons). `IMPLEMENTED AND VERIFIED` for
      the authorization logic itself (15 tests, all real Postgres
      outcomes matching an explicit adversarial acceptance table); still
      not verified end-to-end since no real OpenClaw cell has ever called
      it.
   4. `openclawAdapterService.ts`/`openclawAdapterRouter.ts` - the HTTP
      seam a real cell would call (`POST /api/openclaw/tools/invoke`),
      Bearer-token authenticated via a per-cell callback secret (hash-only
      storage, mirroring `sessionTokenService.ts`). `IMPLEMENTED AND
      VERIFIED` for the adapter's own logic, including a test proving a
      stolen valid token from another tenant is denied by the gateway
      when used against this tenant's real entity/chat IDs - not just an
      HTTP auth failure, an actual cross-tenant business-logic DENY.

   **Real environment finding from this fourth slice, relevant to every
   future OpenClaw slice:** this sandbox actually runs a real Docker
   daemon (`dockerd` starts fine) - what's genuinely blocked is narrower:
   `docker pull` resolves the registry API/manifest for both Docker Hub
   and GHCR, then fails at the layer-download step because both
   registries redirect blobs to CDN domains
   (`production.cloudfront.docker.com`, `pkg-containers.githubusercontent.com`)
   outside this sandbox's egress allowlist. `fleet create` would fail at
   the identical point. Real Fleet verification needs an environment
   whose egress allows those two domains - not a Docker-daemon problem,
   a network-policy one.

   Remaining, in order: (1) encrypted Gateway-token storage using the
   existing `EncryptionService` envelope-encryption path - rotation/
   revocation mechanics need re-verifying against the real Fleet CLI
   before being named as such (Fleet's only documented rotation path may
   be `fleet restore`, not a lightweight standalone operation); (2) a real
   `fleet create` run against an environment with real registry blob
   access; (3) wiring an actual OpenClaw cell's own tool-calling
   configuration to call the adapter built in slice four; (4) OpenClaw
   behind a feature flag for controlled testing against the existing
   Gemini/Goose path, tenant-allowlisted, with an immediate rollback - the
   existing AI path stays primary until all of the above is verified, not
   just implemented.
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
