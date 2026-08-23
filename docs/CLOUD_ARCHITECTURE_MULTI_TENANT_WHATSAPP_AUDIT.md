# Cloud Architecture + Multi-Tenant WhatsApp Connection Audit

**Status: read-only audit + design proposal. No code, schema, migration,
or deployment changes in this document.** Scoped per the user's own
combined framing: "the application is genuinely multi-tenant at the data
layer, but the live WhatsApp connection layer is currently
single-business-per-process" — so this covers both cloud deployment
topology *and* the WhatsApp-connection scaling question together,
deliberately, rather than producing a generic cloud diagram for a system
whose real bottleneck is architectural, not infrastructural.

---

## 1. Current state, traced

**Deployment today**: single-host `docker-compose.yml`, four services
sharing one built image — `app-server` (owns the Baileys socket, runs
migrations on boot, and instantiates **six** in-process BullMQ workers:
`outboundMessagesWorker`, `scheduledStatusPublishWorker`,
`messageRevocationWorker`, `emailSendWorker`, `funnelAdvanceWorker`,
`documentParseWorker`), `app-worker` (only `incomingMessagesWorker`/
`realtimeEventsWorker`, no socket), `postgres`, `redis`. Real hardening
already exists (non-root uid, read-only rootfs, `cap_drop: ALL` on app
containers, resource limits, healthchecks) — see `docs/DOCKER.md`. No
IaC (Terraform/Pulumi/CloudFormation — zero files of any kind), no
CI/CD (`.github/workflows/` doesn't exist), no cloud-provider SDK in
`package.json`. This is a genuine greenfield for cloud migration, but
Phase 1's container-hardening work is a real, reusable foundation, not
something to redo.

**WhatsApp connection** (`whatsappConnectionService.ts`): a hard
singleton. `socket`, `businessId`, `persistedAccountId`, `snapshot`,
`reconnectAttempt`, `reconnectTimer` are all **scalar instance fields**,
not keyed by account — one module-level exported instance for the whole
process. Reconnection is real and reasonable: exponential backoff (1s →
2s → 4s → 8s → 16s → capped 30s) on ordinary disconnects, and on
`DisconnectReason.loggedOut` specifically it wipes the session directory
and forces a fresh QR. Credentials persist to disk on every
`creds.update` via `useMultiFileAuthState()`, so a process crash/restart
resumes without a new QR scan **provided the session directory
survives** — which it does today, via the `whatsapp-session` named
Docker volume, but that volume is mounted **only into `app-server`**.

**The multi-tenancy gap is concrete, not vague**: the data layer is
ready (`whatsapp_accounts` is already keyed `(business_id,
whatsapp_jid)`; `plan_entitlements` already seeds a real
`max_whatsapp_accounts` limit per plan; `EntitlementService
.canConnectWhatsAppAccount(businessId)` already exists and is unit
tested) but **nothing calls it** — `POST /api/whatsapp/connect` calls
`whatsappConnectionService.connect()` directly with no entitlement
check. This is the same class of gap the Phase 7 billing audit already
flagged from the entitlement side; this audit confirms the connection
side never had a second business to check the limit against in the
first place, because `businessBootstrapService
.ensureDefaultBusinessProvisioned()` selects/creates exactly one
business row (`ORDER BY created_at LIMIT 1`) by explicit design, with a
doc comment stating this is a placeholder "until [Auth +
Multi-Tenant phase] replaces it." (Auth and `business_memberships` were
in fact built later — the identity plumbing needed to resolve "which
business is this request for" already exists elsewhere in the app; it
was just never wired to WhatsApp connection.)

**The worker/queue split is more decoupled than it first appears**:
sweep jobs (media-download timeout, call-timeout, AI-handoff, outbound
timeout, etc.) run as **Redis-side BullMQ repeatable job schedulers**
(`upsertJobScheduler`), not in-process `setInterval` — the schedule
lives in Redis, independent of any specific worker process being up at
that instant. That makes `incomingMessagesWorker`/`realtimeEventsWorker`
reasonable Cloud Run candidates in their current form, *if* their
staleness windows (60–300s today) can tolerate whatever cold-start/
scheduling latency a serverless invocation model introduces. The other
six workers are a different story: three of them
(`outboundMessagesWorker`, `scheduledStatusPublishWorker`,
`messageRevocationWorker`) are **structurally pinned** to the socket —
inline comments in `server/index.ts` confirm they exist there
specifically because "the live Baileys socket only exists here." The
other two (`emailSendWorker`, `documentParseWorker`) are co-located "for
operational simplicity," not architectural necessity — genuine
candidates to split out independently of the WhatsApp question.

**A real, working cross-process event bridge already exists** —
`src/realtime/pubsub.ts`, one Redis channel (`whatchatai:realtime`).
`app-worker` already publishes events that `app-server`'s WebSocket
layer subscribes to and forwards to browsers, filtered per-business.
This is not a theoretical extension point; it's the exact mechanism
already crossing the process boundary this audit is about to propose
extending.

**The OpenClaw Cell Runtime is a completely unrelated payload — an
AI-agent sandbox, not a WhatsApp connection — but its *provisioning
pattern* is directly reusable as a template.** Confirmed:
`openclaw_cells` is a one-row-per-business mapping table with
`cell_id`, `gateway_endpoint`, `cell_state` (CHECK-constrained lifecycle
enum: `PENDING/CREATING/RUNNING/STOPPED/UPGRADING/REMOVED/UNHEALTHY`),
`security_status`, quarantine fields, and health-check timestamps.
`OpenClawCellRuntime` is a clean interface (`create/status/stop/start/
upgrade/remove`) with `DockerCellRuntime` as one swappable
implementation, explicitly designed for a future alternative to
implement the same shape. `OpenClawCellService` separates tenant
lifecycle policy (idempotent provisioning, digest-pinned upgrades,
quarantine) from the mechanics of isolation (delegated to the injected
runtime). Deterministic tenant→resource-ID derivation, `docker exec`-
based health checking (not host-port dependent — a real gotcha this
codebase already hit and solved with `--internal` Docker networks), and
per-tenant resource caps round it out. **This is precisely the shape a
future "one isolated WhatsApp connection runtime per business" system
would need** — not the code, the pattern.

## 2. Findings

1. **This deployment can serve exactly one business today**, as a hard
   architectural fact (singleton connection fields + single-row business
   bootstrap), not a soft "one is recommended for now" default.
2. **The `canConnectWhatsAppAccount` entitlement is dead code** —
   already flagged from the billing side in the Phase 7 proposal; this
   audit confirms it's dead because there was never a second business to
   test the limit against, not a separate bug.
3. **The API process is not just an API process.** It's the sole home of
   the Baileys socket and 6 of 8 total BullMQ workers, 3 of which are
   genuinely pinned there by the socket dependency. Any decomposition
   plan has to account for this cluster, not just the ~8 direct
   `whatsappConnectionService.*` call sites in `server/index.ts`.
4. **The communication mechanism for a separated WhatsApp process
   already exists and already works across a process boundary** —
   extending it is far less risk than inventing a new protocol.
5. **No IaC, no CI/CD, no secrets manager exist.** This is real, greenfield
   work, but it's additive to Phase 1's container work, not a redo.
6. **A genuinely reusable provisioning-pattern precedent exists in this
   codebase** (OpenClaw Cell Runtime) for exactly the "isolated runtime
   per tenant" problem a later multi-tenant WhatsApp stage would need.

## 3. Answers to the specific questions posed

**How many customers can one current deployment actually support?**
Exactly one business, hard-architecturally. Not a capacity number — a
structural ceiling.

**Which parts can move directly to Cloud Run?** Fewer than it looks at
first: nearly every `/api/workspace/*` route passes through
`requireWorkspaceContext`, which calls
`whatsappConnectionService.getPersistedContext()` synchronously,
in-process. That dependency has to be decoupled (§5) before the API can
genuinely run as a stateless, horizontally-scaled Cloud Run service —
otherwise "moving the API to Cloud Run" just means running the same
socket-coupled monolith on different infrastructure, gaining none of
Cloud Run's actual benefit. `incomingMessagesWorker`/
`realtimeEventsWorker` are the best near-term Cloud Run (Jobs, or a
min-instances=1 Service) candidates as-is, since neither touches the
socket directly.

**Which parts must remain persistent?** The Baileys socket itself (a
long-lived WebSocket to WhatsApp's servers cannot be scale-to-zero by
nature) and, as currently built, the three workers pinned to it
(outbound dispatch, scheduled status publish, revocation) — all three
need to enqueue against the same live connection an outbound send
requires.

**How should the WhatsApp process communicate with the API once
separated?** Extend the existing Redis pub/sub bridge (§1) for
*events out* (message received, status changed, media ready — already
exactly this shape). For *commands in* (send this message, connect,
disconnect, fetch QR), the natural fit given this codebase's own
conventions is a **BullMQ job queue**, not a new HTTP/RPC protocol —
`outboundMessagesWorker` already consumes a queue for sends; splitting
the connection process out just means that queue's consumer moves to
the new process. No new communication mechanism needs inventing.

**One connection manager handling many accounts, or many isolated
single-tenant runtimes?** Concrete recommendation, not a default: start
with **one process holding many concurrent sockets, keyed by
accountId** (§4 Stage 2) — Baileys connections are lightweight
WebSocket clients, not full processes, so this scales further than it
sounds before hitting a real ceiling. Move to **isolated per-tenant
runtimes** (§4 Stage 3, reusing the OpenClaw Cell Runtime pattern) once
a real constraint appears: one tenant's crash/reconnect storm affecting
every other tenant sharing the process, noisy-neighbor resource
contention, or a customer requiring dedicated network egress isolation
for compliance reasons. This mirrors the user's own Stage 2/3 intuition
with a concrete trigger condition instead of a guessed threshold.

**How should sessions/auth state be stored and backed up?** Stage 2:
per-account subdirectories under one shared volume (a moderate,
well-scoped refactor — see §5), with the volume snapshotted on a
schedule. Stage 3: each isolated runtime gets its own small dedicated
volume, exactly mirroring how each OpenClaw cell already gets its own
resource footprint.

**What happens when a WhatsApp runtime crashes?** Already handled well
at the single-tenant level today (backoff reconnect + persisted
creds), and the design generalizes directly: `restart: unless-stopped`
already exists; the volume-persistence pattern is proven. The one real
gap for multi-account: today's boot sequence auto-connects only the one
default business (`server/index.ts`'s `void whatsappConnectionService
.connect()` on startup) — a keyed-map version needs a startup routine
that reconnects every previously-connected account from the
`whatsapp_accounts` table, not just one.

**How are businesses routed to the correct connection?** Doesn't exist
today (nothing to route to). Proposed: `whatsapp_accounts` (already
keyed by `business_id`) becomes the routing source of truth. The API
layer resolves the account from the authenticated session (auth
already exists) and looks up either the in-process Map entry (Stage 2)
or a runtime-mapping-table record (Stage 3, structurally identical to
`openclaw_cells`).

**Cheapest architecture at 1 / 10 / 100 / 1,000 businesses?** See §4's
table.

**What must change before pursuing much larger scale?** The
`requireWorkspaceContext`/socket decoupling (§5) and the singleton →
keyed-map refactor of `WhatsAppConnectionService` (§5) are the real
prerequisites — everything else (Cloud Run for the API/frontend,
managed Postgres/Redis, secrets manager) is comparatively mechanical
and doesn't require touching this codebase's hardest architectural
assumption.

## 4. Proposed staged target architecture

| Stage | Businesses | WhatsApp connection | API | Workers | DB/Redis | Real trigger to move to next stage |
|---|---|---|---|---|---|---|
| **0 — today** | 1 | Singleton, in-process with API | Same process as socket | Split 6/2 as described | Docker-local | — |
| **1 — cloud foundation** | 1 (unchanged) | Same singleton, moved to a small persistent VPS/container with a real volume | Cloud Run, still calling into the WhatsApp process's queue/pubsub rather than in-process (§5's decoupling is the actual work of this stage) | `incomingMessagesWorker`/`realtimeEventsWorker` → Cloud Run; the 3 socket-pinned workers stay with the connection process; `emailSendWorker`/`documentParseWorker` can split independently | Managed Postgres + managed Redis, secrets out of `.env` | Ready to onboard a second real paying business |
| **2 — in-process multi-account** | ~10–100 | One connection process, sockets keyed by `accountId` in a `Map`, per-account session subdirectories | Unchanged from Stage 1, now resolves `accountId` per request | Unchanged shape, now iterate per-account | Unchanged | One tenant's crash/reconnect storm visibly affects others, or a compliance need for per-tenant network isolation |
| **3 — isolated per-tenant runtime** | 100–1,000+ | One container per business, provisioned/tracked/health-checked via a runtime-mapping table + swappable runtime interface — directly modeled on the existing OpenClaw Cell Runtime pattern | Unchanged, resolves the tenant's `gateway_endpoint`/queue from the mapping table | Same split as Stage 2, now per-cell where it matters | Managed, with per-tenant read replicas/sharding evaluated only if the data layer (not the connection layer) becomes the bottleneck | — |

Stage 1 is genuinely buildable now with no unresolved decisions — it's
your own "Phase 1: cheapest reliable launch architecture" from earlier
in this conversation, adjusted only by making the §5 decoupling work
explicit as part of it rather than assumed away. Stages 2 and 3 require
the refactor in §5 as a prerequisite for Stage 2, and reuse (not
rebuild) the OpenClaw pattern for Stage 3.

## 5. The prerequisite refactor (what actually blocks Stage 2+)

Two changes, genuinely scoped, not a rewrite:

1. **`WhatsAppConnectionService`'s scalar fields become
   `Map<accountId, ConnectionState>`** — `socket`, `businessId`,
   `persistedAccountId`, `snapshot`, `reconnectAttempt`,
   `reconnectTimer` all move from instance fields to values in one map.
   Every one of the ~15 `socket.ev.on(...)` handlers in
   `attachEventHandlers` closes over `this.businessId`/
   `this.persistedAccountId` implicitly — each needs to close over the
   specific account's context instead (the existing `withSyncContext`
   wrapper is the natural place to carry that). `DEFAULT_SESSION_DIR`
   becomes a per-account path function. Boot-time auto-connect iterates
   every account with a live/expected connection instead of calling
   `.connect()` once.
2. **`requireWorkspaceContext` stops calling
   `getPersistedContext()` in-process** — it resolves the
   business's connection state from wherever Stage 1 put it (a small
   internal query against the connection process, or a cached
   Redis-backed status the connection process publishes on every state
   change — the same pub/sub channel already carries the right shape of
   event). This is the piece that actually lets the API run as a
   separate, horizontally-scaled process instead of just being
   relocated.

Neither of these requires deciding anything about cloud providers,
payment processors, or business policy — they're pure engineering, the
same category of work as the media-retry state machine or the AI
debounce fix already shipped in this engagement.

## 6. What this phase would actually touch (if authorized)

- **Stage 1** (cloud foundation): no code changes to
  `whatsappConnectionService.ts` itself — deployment/infra only
  (managed Postgres/Redis connection strings, secrets manager wiring,
  Cloud Run service definitions for the API and the two decoupled
  workers, a persistent-volume-backed host for the connection process).
  This is safe to schedule independently and immediately.
- **Stage 2 refactor** (§5): `whatsappConnectionService.ts` (the
  singleton→map change), `server/index.ts`'s
  `requireWorkspaceContext` and the 8 direct call sites, one new
  migration if a runtime-status cache table is preferred over a
  Redis-only status, and wiring `canConnectWhatsAppAccount` into the
  connect path (closing finding 2 as a natural side effect).
- **Stage 3** (isolated runtimes): a new mapping table modeled on
  `openclaw_cells`, a `WhatsAppConnectionRuntime` interface modeled on
  `OpenClawCellRuntime`, and a `DockerCellRuntime`-equivalent concrete
  implementation — genuinely new code, but following an established,
  already-tested pattern rather than an unprecedented design.
- **Explicitly not touched by this doc**: no cloud provider is chosen
  here (Cloudflare + Cloud Run remains a reasonable default per the
  earlier discussion, but that's a Stage 1 execution decision, not an
  architectural one this audit needs to resolve); no payment/billing
  code (Track A/B from the Phase 7 proposal are independent of this).

## 7. Regression test plan (for Stage 2, if authorized)

1. Two accounts connect concurrently in one process — each gets its own
   QR, its own session directory, and closing one socket's connection
   never affects the other's `snapshot`/`reconnectAttempt` state.
2. A crash/restart with two previously-connected accounts resumes both
   from persisted creds, not just the first one found.
3. `canConnectWhatsAppAccount` actually refuses a connect attempt at the
   plan's `max_whatsapp_accounts` limit, mirroring every other
   entitlement check's existing test pattern.
4. Cross-tenant: an account lookup/status/QR request for a business
   other than the authenticated one is refused identically to a
   nonexistent account, matching this engagement's standing
   `findByIdForBusiness` convention.
5. `requireWorkspaceContext`'s new resolution path returns the same
   `WHATSAPP_NOT_CONNECTED` 409 shape as today when a business has no
   live connection — no behavior regression on the existing single
   business case.
6. A `loggedOut` disconnect on one account wipes only that account's
   session directory, never another account's.

---

**Recommendation**: authorize Stage 1 now — it's genuinely
decision-free infrastructure work that also lays the groundwork
(managed Postgres/Redis, secrets out of `.env`) every later stage needs
regardless of the connection-architecture question. Treat §5's refactor
as its own explicitly-scoped follow-up once Stage 1 is live, since it's
real engineering risk (touching the one component every other route in
this app depends on) that deserves its own careful review pass rather
than being bundled into an infra migration.
