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
3. **AI Runtime adapter / OpenClaw** - *deferred, not unverified, but
   blocked on a real decision*: OpenClaw's own trust model is one
   deployment per operator, meaning per-tenant WhatsApp business here -
   a real infrastructure/cost decision the user has not yet made. Building
   an `AiRuntime` interface with only one real implementation (Gemini) and
   a stub second one would be exactly the "framework for a hypothetical"
   the governing principle above warns against. Build the adapter *when*
   OpenClaw deployment is actually decided, not before.
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
