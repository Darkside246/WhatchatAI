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
5. **Business Isolation Hardening (Phase 1 of the Knowledge Base 2.0
   roadmap)** - a real, evidence-based audit confirmed `businessId` is
   already derived exclusively server-side everywhere (never from AI
   tool-call arguments, model output, or unauthenticated request input),
   but 8 repositories exposed only an unscoped `findById`, relying on
   every caller to manually re-check ownership afterward. Added
   tenant-scoped `findByIdForBusiness`/`findByIdForUser` variants to all
   8 and migrated every real production caller (~20 call sites) to them,
   removing now-redundant manual checks. Added the adversarial
   cross-tenant tests the audit found missing (funnels, whatsapp_media,
   outbound messages, subscriptions); message revocation already had
   one. Introduced `src/domain/businessExecutionContext.ts` (the shared
   context shape for Phase 2+) without retrofitting existing services.
   `IMPLEMENTED AND VERIFIED` - see `CHANGELOG_SECURITY.md` for full
   detail. Knowledge Base 2.0 itself (Phases 2-6: document security
   model, PDF/DOCX ingestion, Google Drive/Dropbox connectors, AI
   document-sending, adversarial real-world testing) remains explicitly
   gated behind this and not yet started.

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
   two. **Re-verified for real (2026-08-22): `VERIFIED`.** A full
   create→status→stop→start→status→remove lifecycle run against a live
   container succeeded end to end (`create()` 22.7s, `start()` 16.8s,
   both `status()` calls reporting `healthy: true`) - the exact restart
   path that had been broken twice over (the timing-cap bug, then this
   published-port conflict) is now confirmed working. Host-gateway
   reachability (`host.docker.internal`) itself remains unverified -
   deprioritized in favor of the health-check fix, to be revisited only
   if/when the OpenClaw-agent research (below) determines it's actually
   needed.

   The full `DockerCellRuntime` lifecycle and its egress-containment
   properties are now real-runtime `VERIFIED`, not assumed from code
   review or mocked tests alone. Explicitly still gates the next item: no
   provider credential (OpenAI, Gemini, or otherwise) is to be placed in
   a cell until encrypted token storage is built.

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

   **`purgeData` containment: `IMPLEMENTED AND VERIFIED` (2026-08-22).**
   `resolveContainedCellStateDir()`/`purgeCellStateDir()` (exported from
   `dockerCellRuntime.ts` for direct testing) replace the prior no-op:
   `lstat`-based symlink rejection (never followed, regardless of target),
   strict allow-list validation of `cellId` independent of
   `openclawCellService.ts`'s own check, and a `path.relative`-based
   containment confirmation that the target is exactly one direct child
   of the state root - never nested, never the root itself. Pure Node
   `fs` logic with no Docker dependency, so unlike the rest of this
   runtime it's verified directly in this sandbox against a real
   filesystem (609/609 tests, 20 new - 11 parametrized adversarial
   rejection cases plus symlink-inside/symlink-outside/non-directory/
   idempotent-absent cases, each proving a real canary file outside the
   state root survives untouched, not just that the call threw). No real-
   hardware re-test needed the way the Docker-orchestration changes did.
   `remove()`'s container/network removal and state-directory deletion
   stay two genuinely separate steps - a purge failure now surfaces as a
   thrown error naming the cell, rather than being reported as a silent
   successful cleanup.

   **Encrypted Gateway-token storage: `IMPLEMENTED AND VERIFIED`
   (2026-08-22).** Migration 066 adds `gateway_token_encrypted` to
   `openclaw_cells`; `OpenClawCellRepository.setGatewayToken`/
   `getGatewayToken`/`hasGatewayToken` use the identical AES-256-GCM
   envelope mechanism (`EncryptionService`) `business_email_settings`/
   `business_goose_settings` already use - not a new scheme invented for
   this field. Deliberately kept out of `OpenClawCellRecord` entirely
   (mirroring `callback_token_hash`'s own exclusion), so an ordinary
   record read can never carry it, encrypted or not.
   `provisionCellForBusiness` still returns the plaintext once, at the
   moment of provisioning - the same "shown once" pattern the callback
   token uses - never again after that. 613/613 tests passing (20 new),
   pure application/DB logic with no Docker dependency, so - like
   `purgeData` - no real-hardware re-test was needed.

   **OpenClaw internal-agent/tool-invocation research (2026-08-22):**
   `openai/gpt-5.5` is real but configurable, not hardcoded -
   `agents.defaults.model` accepts a provider/model string or a
   `{primary, fallbacks}` object, and **Gemini is a first-class supported
   provider** (`@openclaw/google-plugin` ships enabled by default; the
   config schema's own example literally shows `"google/gemini-2.5-flash"`).
   Tool invocation is genuinely MCP (Model Context Protocol)-based
   (`openclaw mcp` config surface), and this was proven, not assumed -
   see `CHANGELOG_SECURITY.md`'s "MCP wire-protocol verified" entry: a
   real disposable MCP server + a real disposable Gemini credential, host-
   only, confirmed the real JSON-RPC handshake (protocol version
   `2025-11-25`), that an included tool is genuinely invoked, and -
   critically - that an excluded tool is not merely declined but **absent
   from the tool schema the model ever sees**, with the disposable
   server's own log independently confirming zero invocation attempts.
   Two more independent control layers exist beyond MCP filtering:
   `openclaw approvals` (a per-agent exec-command allowlist, separate from
   MCP tools) and `commands.ownerAllowFrom` (gates privileged commands via
   a connected chat channel - moot as long as no channel is ever logged
   into a cell, which nothing in this design does). OpenClaw's own
   built-in `security audit` tool states its trust model explicitly:
   *"personal assistant (one trusted operator boundary), not hostile
   multi-tenant on one shared gateway"* - direct, first-party confirmation
   of the premise this whole architecture has been built around since the
   very first OpenClaw research pass. One important methodology note
   preserved from this pass: an early `security audit --deep` run against
   the bare host (not a hardened cell) produced a misleading CRITICAL
   "no gateway auth" finding - it was auditing an unrelated, unconfigured
   local install with nothing listening, not one of our real `--auth
   token`-protected cells; caught before being treated as a real finding
   about our architecture.

   **In-cell security audit (2026-08-22): run, real findings acted on
   where the fix was self-contained.** `security audit --deep --json`
   from inside a real hardened cell confirmed gateway auth is clean (no
   longer flagged, unlike the earlier bare-host run) and reconfirmed
   `tools.elevated`/browser control are still enabled by default. It also
   surfaced a new CRITICAL finding not on the original checklist:
   `/home/node/.openclaw` was `mode=777` (world-writable) - fixed:
   `dockerCellRuntime.ts`'s `create()` now `mkdir`s and `chmod(0o700)`s
   the state directory itself rather than trusting Docker's bind-mount
   auto-creation default (`IMPLEMENTED AND VERIFIED`, real filesystem
   test, no Docker dependency). One operational discovery, not a code
   bug: `--deep` fires a real embedded-agent turn as part of its own
   self-check, which - with no provider credential and `--internal`
   blocking egress - hangs for minutes rather than failing fast; any
   future automated invocation of `security audit --deep` against a cell
   needs a `timeout` wrapper.

   **Attack-surface reduction (2026-08-22): `IMPLEMENTED BUT NOT FULLY
   VERIFIED`.** Real config paths found and live-verified by the user
   directly against a real cell: `tools.elevated.enabled` and
   `browser.enabled`, both real boolean keys in `openclaw config schema`,
   both confirmed via a live audit re-run to shrink the attack-surface
   summary when set to `false`. `dockerCellRuntime.ts`'s container command
   now runs both `openclaw config set` calls before `exec`-ing the gateway
   process - the same real CLI mechanism already proven correct, not a
   hand-constructed config file. Re-run against a fresh real container:
   boot logs show the config-set calls landing before the gateway starts,
   and the in-cell audit confirms both disabled by default with zero
   manual steps - `VERIFIED` unconditionally now, not just the values.

   **State-directory permission fix: `IMPLEMENTED AND VERIFIED`
   unconditionally (2026-08-22), previous NTFS uncertainty resolved.** A
   real differential test - identical code and container command, run
   once with the state dir on a Windows NTFS path (`mode=777`, 1
   CRITICAL finding) and once on a genuine WSL2-native (ext4) path
   (confirmed via `uname -a` reporting a real Linux kernel, not an
   emulating shell) - confirmed the fix works correctly on a real Linux
   filesystem: `drwx------` (`0700`) on the host, `"critical": 0` in the
   in-cell audit. The earlier `mode=777` finding was genuinely specific
   to Docker Desktop's NTFS bind-mount handling on the Windows test
   machine, not a defect in the fix - production runs on native Linux,
   where this is already confirmed correct.

   **Real WhatchatAI MCP server: `IMPLEMENTED AND VERIFIED (standalone)`
   (2026-08-22).** `src/services/openclawMcpServer.ts` +
   `src/server/openclawMcpRouter.ts`, built on the official
   `@modelcontextprotocol/sdk` (not hand-rolled), exposing exactly
   `update_lead` as a thin translation layer in front of the unmodified
   `OpenClawToolGateway.invoke()` - no new WRITE tools, no direct DB/
   repository access from the MCP layer, no second policy engine or rate
   limiter, no bypass around the gateway. Authentication mirrors the
   existing REST adapter exactly (Bearer callback token, hash-looked-up,
   `businessId`/`cellId` taken only from the authenticated cell record,
   never a tool argument). `chat_id`/`cell_generation` are ordinary
   model-visible tool arguments - not a new design decision, but a direct
   mirror of the REST adapter's own already-reviewed precedent (both are
   caller-claimed there too; a wrong value only ever produces a real
   gateway DENY via the existing fencing check, never a privilege
   escalation). Idempotency reuses the gateway's existing
   `idempotencyKey` conflict-detection - no second scheme. Feature-gated
   and disabled by default (`OPENCLAW_MCP_SERVER_ENABLED=true` required
   to mount the route).

   Tested standalone against a real MCP client, twice, per the user's
   explicit requirement, before any live-agent wiring: (1)
   `test/openclawMcpServer.test.ts`, 24 tests against real Postgres and
   the real gateway, using the SDK's own `Client` +
   `InMemoryTransport.createLinkedPair()` - a genuine MCP session, not a
   protocol fake - covering the full 12-point acceptance list (tool
   exposure, real gateway reach, cross-tenant denial, invalid-auth
   denial, idempotent replay, conflicting-key denial, stale-generation
   denial, quarantine denial, field-allow-list denial); (2) a real
   disposable end-to-end round trip - the actual server booted with the
   flag on, a real business/cell/lead provisioned, driven over genuine
   HTTP via raw `curl` JSON-RPC through the full
   `initialize`/`notifications/initialized`/`tools/list`/`tools/call`
   sequence, confirming real protocol negotiation
   (`protocolVersion: "2025-11-25"`), a real 401 DENY on a bad token, and
   a real lead-row mutation driven purely through the wire protocol.
   624/624 tests passing, full typecheck clean, no regressions. See
   `CHANGELOG_SECURITY.md`'s matching 2026-08-22 entry for the complete
   evidence.

   **Stage 0 real-hardware finding (2026-08-22): a hardened cell cannot
   reach the MCP endpoint at all as things stood.** Real testing on the
   user's machine (a disposable cell + the real MCP-flagged server)
   confirmed `host.docker.internal` resolves, but `--internal` blocks the
   actual route to the host entirely - not just general internet egress,
   contrary to the plan's original assumption that host reachability was
   a narrower, separate gap. Two candidate fixes were tested for real
   before committing to either: a second bridge network with
   `enable_ip_masquerade=false` was disproven (it did NOT block general
   internet egress on this Docker Desktop/WSL2 setup - `example.com` and
   `1.1.1.1` both returned real, successful responses); host-level
   `DOCKER-USER` iptables allow-listing was ruled out for lack of
   `iptables`/`nft` tooling in this Docker Desktop VM, and more
   fundamentally because host firewall administration isn't something
   this codebase's Docker-API-only orchestration could portably manage in
   production regardless.

   **Per-cell relay: `IMPLEMENTED AND UNIT-TESTED` (2026-08-22), real-
   hardware Phase 2 verification pending.** The approved fix: a dedicated
   per-cell relay container - a destination-specific egress gateway, not
   a general proxy - with a structural (not merely checked) two-route
   allow-list (`/mcp`, `/gemini/*`) and no code path anywhere capable of
   accepting a caller-supplied forwarding target. One relay per cell,
   attached into that cell's existing `--internal` network (reachable by
   the cell, exactly as before) plus a second, dedicated, non-`--internal`
   egress network only the relay ever joins - the cell itself never
   touches it, so a compromised relay has no path to another cell or its
   relay. Real protections built into the relay itself: DNS-rebinding
   defense on the Gemini route (connects to the address it actually
   resolved, rejects private/loopback/link-local/CGNAT results, with the
   MCP route's private-range target as the sole deliberate exception), no
   redirect-following, bounded body size and request timeout, and
   metadata-only logging that never captures request/response bodies, the
   `Authorization` header, or the query string (Gemini's own convention
   can put an API key there, not just in a header). `dockerCellRuntime.ts`
   now creates/health-gates/tears down the relay alongside the cell
   through the same `create()`/`stop()`/`start()`/`upgrade()`/`remove()`
   lifecycle, not a separate mechanism. Built from this repository (a new
   `relay-runtime` Dockerfile stage), not pulled from a registry -
   deliberately needs no `node_modules` at all, since the relay's own code
   imports nothing but Node built-ins. 657/657 tests passing (30 new for
   the relay's own routing/security logic against real local stand-in
   upstreams, no Docker required; 37 for the runtime wiring, mocked
   `execFile` matching this file's existing pattern), full typecheck
   clean, a real `tsc` build confirmed. See `CHANGELOG_SECURITY.md`'s
   matching entry for the complete evidence trail.

   **Phase 2 real-hardware verification: `PASSED` (2026-08-22), all 8
   tests.** Two real disposable cells, each with its own real relay,
   provisioned end-to-end through the actual production code path
   (`openclawCellService.provisionCellForBusiness`) on the user's
   machine. Every test from the approved plan run for real: `cell →
   relay → MCP` genuinely works (a real `200 OK` MCP `initialize`
   response, driven all the way from inside a hardened cell's own
   container through its relay to the real WhatchatAI server - the first
   time this has ever happened in this engagement); `cell → internet`
   still fails; `cell → another cell` still fails; `cell → arbitrary IP`
   fails; the relay's structural allow-list rejects anything outside its
   two fixed routes; a compromised relay cannot reach another cell or its
   relay (confirmed from *inside* the relay's own container, not just the
   cell); removing a cell tears down its relay and both networks
   together (a real before/after sweep across both cells, all four
   resources present then absent); restarting a cell does not broaden
   access (re-verified isolation and MCP reachability after a real
   stop/start cycle). One real bug was found and fixed along the way
   (`fd23a51` - the relay's health check tried to use `curl`, which its
   own deliberately-`node_modules`-free image doesn't have; fixed to use
   Node's built-in `fetch` instead). See `CHANGELOG_SECURITY.md`'s
   matching entry for the full raw evidence.

   Remaining, per the user's own build order - Phase 3, gated on
   explicit approval before any credential goes near a cell: design and
   verify the provider-specific (Gemini) egress path for real, inject a
   disposable Gemini credential into one disposable hardened cell under
   the constraints already agreed (dedicated key, lowest practical
   spend/rate cap, explicit model, no persistence, time-boxed), wire this
   MCP server into a live OpenClaw agent, and run the real agent → relay
   → Gemini → MCP → Tool Gateway → PostgreSQL test plus the adversarial
   cases (wrong-tenant `chat_id`, stale `cell_generation`, quarantine,
   excluded tool, cross-tenant target, idempotency conflict) from the
   agent itself. Only after all of that: enable
   `OPENCLAW_MCP_SERVER_ENABLED` and tenant-allowlist behind a feature
   flag - the existing Gemini/Baileys path on `phase-2-ai-repair` remains
   completely untouched throughout.
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
