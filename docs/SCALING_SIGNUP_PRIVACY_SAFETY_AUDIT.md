# Scaling, Public Signup, Privacy & Production Safety — Combined Audit

**Status: read-only audit + prioritized proposal. No code, schema, migration,
or deployment changes in this document.** Commissioned as one combined ask:
"the fastest and safest way to scale this into multi-tenant software with an
app and website to sign up," folded together with the standing privacy
directive (logged in `ARCHITECTURE_STATUS.md` §3 before this audit existed)
and a general request to surface gaps, trends, and production/safety risk —
all under an explicit **zero-budget, bootstrapped** constraint. This
document does not repeat what `docs/CLOUD_ARCHITECTURE_MULTI_TENANT_WHATSAPP_AUDIT.md`
(the WhatsApp-connection-layer and cloud-topology audit) or
`docs/PHASE_7_BILLING_PRICING_AUDIT_AND_PROPOSAL.md` (the billing/pricing
schema audit) already covered — it cites them and builds the parts they
didn't: public self-serve signup, data-minimization/privacy, and
backups/monitoring/secrets/rate-limiting/CI production safety.

---

## 0. Method

Three independent read-only research passes traced actual code (file:line
citations throughout, not assumptions), covering: (1) what exists today for
self-serve business signup and what a public marketing site would need, (2)
exactly what personal/sensitive data is encrypted vs. plaintext and whether
any retention/deletion policy exists anywhere, (3) backups, monitoring,
secrets management, rate-limiting, dependency security, TLS, and CI/CD. This
document synthesizes all three plus the two prior audits into one merged,
cost-tagged, risk-tagged roadmap.

---

## 1. Executive summary

**The good news, stated plainly**: this codebase's hardest problems are
already solved. Real per-tenant AES-256-GCM encryption exists and is
proven across 5 call sites. Real tenant isolation (`requireAuth` →
membership → `businessId`) is correctly wired into nearly every route.
Real guarded state machines, idempotent retries, and a working
cross-process event bridge already exist. Crash-safety was closed in a
prior pass. None of that needs to be rebuilt — it needs to be **extended
to the parts of the app that were built after it and never caught up.**

**The bad news, stated plainly**: three things are currently unmitigated
and would each independently be a serious incident if a second real
paying business signed up tomorrow: (1) a **silent cross-tenant data leak
landmine** in two auth call sites that still resolve "the business" as
"the first row in the table" instead of the authenticated session's own
business, (2) **zero backup mechanism** for Postgres or the WhatsApp
session volume — total, unrecoverable data loss is one bad `docker volume
rm` or disk failure away, (3) **no way to actually take a second
business's money** — no payment processor, no checkout, and self-serve
signup is a hard-coded single-use gate, not a real feature.

**On the budget question, directly**: roughly 90% of what's below costs
$0 — it's engineering time against free tiers (GitHub Actions, Sentry
free tier, UptimeRobot, Cloudflare Turnstile, Neon/Supabase free
Postgres, Upstash free Redis, Resend/SES free email). The one item with
no free path is **collecting real payment** once you have a paying
customer — and that can be deferred: launch on trial-only or
manual-invoice signup first, prove demand, then add a payment processor
when there's revenue to justify the integration work.

---

## 2. Section A — Self-serve multi-tenant signup (the "app + website")

### 2.1 Current state, traced

`isRegistrationOpen()` (`src/services/authService.ts:56-60`) is a **true
hard block**, not a disguised multi-tenant path: it counts memberships on
the one bootstrap business and returns `count === 0`. `register()`
(`authService.ts:68-94`) throws `RegistrationClosedError` the moment that
count is ≥1. There is no `businessRepository.create()` method at all —
`ensureDefault()` (`businessRepository.ts:45-56`) only ever
`SELECT`s-or-inserts a single row. **No code path anywhere creates a
second `businesses` row.** The frontend has zero public routes: no
router library is even in use for public pages, `App.tsx` renders either
`RegisterPage` (bootstrap-only, no business-name or plan-picker field) or
`LoginPage` — there is no `/pricing`, `/about`, or landing page of any
kind. This is not a partially-built feature; it's greenfield.

The billing *schema* is further along than the signup *flow*: plans,
entitlements, and subscriptions tables are real and per-business-scoped,
and `EntitlementService` genuinely enforces limits server-side — but
`subscriptions.status` can only ever become `TRIALING` (nothing else
writes to it), there is no payment provider dependency anywhere in
`package.json`, and `BillingRoute.tsx` is deliberately read-only. Neither
email verification nor password reset exists at all — no tokens table,
no functions. Login has real brute-force throttling (8 failures/15min);
registration has none.

One genuinely good finding: the tenant-isolation mechanism itself
(`requireAuth` → `validateSession` → `membership.businessId` →
`res.locals.auth.businessId`) is **already multi-tenant-safe** across
nearly every route. It doesn't need to be built — it needs its two
exceptions fixed (§4.1).

### 2.2 What a real public signup needs, cost-tagged

| Piece | Exists today? | Cost to close |
|---|---|---|
| Public marketing/landing page | No | **Free** — one router + a couple of public routes on the existing frontend, zero new infra |
| Business-name + plan-picker on registration | No (bootstrap-only form) | **Free** — new `businessRepository.create()`, drop the single-row assumption |
| Wiring a chosen plan to a real `subscriptions` row | Schema ready, no wiring | **Free** — engineering only |
| Fix `login()`/`/api/auth/me` to resolve business by membership, not "the first row" | No — see §4.1 | **Free**, and urgent (correctness bug, not a feature) |
| Transactional email (verify email, reset password) | Doesn't exist (the existing email system is the *business's own* outbound-to-customers feature, unrelated) | **Free tier covers it** — Resend (3k/mo free) or SES free tier |
| Bot/abuse protection on the signup form | None | **Free** — Cloudflare Turnstile |
| Registration rate-limiting | None (login has it; registration doesn't) | **Free** — same pattern as the existing login throttle, reused |
| Real payment collection (Stripe or similar) | Doesn't exist anywhere | **No free option** — the one genuine cash-shaped decision in this whole audit |
| Tax/invoicing/dunning | Doesn't exist | **No free option**, but only relevant once payment exists |

---

## 3. Section B — Privacy & data minimization (the standing directive)

Restating the bar you set: Telegram/ProtonMail-level privacy, taken
further — never retain information that isn't needed, never retain
anything that could function as an evidence trail against your
customers' customers, while keeping real chat history usable. This
section is that audit.

### 3.1 What's genuinely well-protected today

Real AES-256-GCM envelope encryption with per-tenant HKDF-derived keys
(never persisting the derived key) is proven and already covers: WhatsApp
message text, media bytes at rest, Writing Twin style samples, and
integration secrets (API tokens). `security_audit_logs.raw_metadata` is
disciplined by convention — every writer passes only structural fields
(`{stage: ...}`), never message content or names. Sessions store only a
SHA-256 hash of the bearer token, never the raw token. The Writing Twin
subsystem has a real, working, transactional hard-delete
(`deleteAll`/`resetProfile`) and a schema-level `expires_at` column.

A broad sweep of application logging (39 files using `console.*`) found
the codebase largely disciplined — sampled call sites log IDs and static
reason strings, not raw message bodies, names, or phone numbers. This
wasn't verified exhaustively line-by-line, but no offender was found.

### 3.2 Plaintext-retention gaps, ranked by severity

1. **Notifications — highest severity.** `notifications.title`/`body`
   are plain `TEXT`, never expire, and the repository's own code comment
   already admits this is unfinished. The recent "mark all read" fix only
   flips `dismissed_at`/`read_at` — every "human handoff," "new lead,"
   "SLA breach" notification persists in plaintext forever, invisible in
   the UI but readable by anyone with database access. This is exactly
   the "evidence trail nobody sees but still exists" shape the directive
   names.
2. **CRM contact notes / lead notes.** `crm_contacts.notes`,
   `crm_contacts.ai_summary`, `leads.notes`, `leads.next_action` are
   plain `TEXT`, zero use of `EncryptionService` in the CRM repository.
   Freeform staff commentary about a real customer, unencrypted.
3. **Campaign message text.** Plaintext, never encrypted, no expiry.
4. **Session metadata.** `ip_address`, `user_agent`, `device_name` are
   plaintext, and revoked/expired sessions are never purged — only
   marked revoked. Indefinite device/IP history accumulates per user.
5. **Funnel step config.** Can carry message templates/business logic in
   plaintext JSONB, unencrypted.

### 3.3 The retention/deletion picture

There is exactly one real TTL in the entire schema —
`writing_twin_raw_events.expires_at` — and its sweep method
(`sweepExpiredRawEvents()`) is fully implemented but **only ever called
from a test file.** It has never been wired into the BullMQ scheduler
that already runs nine other sweep jobs on a schedule. Every one of those
nine sweeps *reconciles stale state*; none of them *deletes* anything.
There is no purge, TTL, or scheduled cleanup for notifications, security
audit logs, WhatsApp messages, CRM contacts, leads, campaigns, or
sessions. There is no "delete my account/data" API route anywhere in the
app — the only user-triggered hard-delete is Writing-Twin-scoped.

### 3.4 Third-party exposure — the one finding outside this app's own control

Real customer message content genuinely leaves the app and reaches
Google's Gemini API: the Security Sentinel sends raw inbound text for
injection/jailbreak screening, and AI reply generation sends full
decrypted conversation history plus CRM context on essentially every
AI-handled message. This is architecturally necessary for the product to
function (an AI agent that can't read the conversation can't reply to
it) — it's not a bug, but it is a fact worth being explicit about in any
privacy policy: encryption-at-rest in your own database doesn't change
what a third-party model provider sees in transit.

### 3.5 Cost to close

Everything in §3.2 and §3.3 is a **pure, free code change** — encrypting
four more text columns via the exact same `EncryptionService` pattern
already proven at five other call sites, and wiring purge sweeps using
the exact same BullMQ scheduler pattern already proven at nine other call
sites. This is mechanical extension of existing, tested infrastructure,
not new design. The only genuinely infrastructure-costed item is a real
cloud KMS to replace the current local-master-key stand-in — worth doing
eventually, not urgent at bootstrap scale. The Gemini exposure (§3.4)
isn't closeable in code; it belongs in your privacy policy language and,
if it ever matters enough, a data-processing-agreement conversation with
Google — outside this document's scope.

---

## 4. Section C — Production safety (backups, monitoring, secrets, abuse, deps, TLS, CI)

### 4.1 The single most severe finding across the entire audit

**Two auth call sites resolve "which business" incorrectly.**
`login()` and `GET /api/auth/me` both call
`ensureDefaultBusinessProvisioned()` (always returns the *first*
`businesses` row) instead of resolving the business via
`membership.businessId`, the way every other authenticated route
correctly does. This is invisible today because only one business
exists. The moment a second business is onboarded, this silently returns
**the wrong tenant's business object** to some fraction of authenticated
requests — a cross-tenant data leak, not a cosmetic bug. This must be
fixed *before* a second business ever signs up, independent of anything
else in this document, and it's a small, mechanical fix (swap the call
site to resolve via the session's own membership, matching the pattern
already used everywhere else).

### 4.2 Backups — zero exist, for anything

No `pg_dump`, WAL archiving, snapshot, or backup script of any kind
exists anywhere in the repository. Postgres and the WhatsApp session
volume are plain, unprotected Docker volumes. Losing the Postgres volume
destroys every tenant's data outright. Losing the WhatsApp session volume
forces every connected business to re-scan a QR code — an outage every
customer notices immediately, with no data loss but real trust damage.
For a bootstrapped SaaS about to hold other businesses' customer data,
this is the highest-severity *infrastructure* gap in the whole audit
(the auth bug in §4.1 is higher severity but is a code fix, not an
infra gap).

- **Zero-budget fix**: a nightly `pg_dump | gzip` cron on the existing
  host pushed to Backblaze B2 or Cloudflare R2's free tier costs
  effectively nothing. Same pattern, less frequently, for a `tar` of the
  session volume.

### 4.3 Monitoring, alerting, error tracking

`pino` is installed but genuinely unused — zero imports anywhere in
`src/`. All logging is ad hoc `console.*`. No Sentry, Datadog, Honeycomb,
Prometheus, or Grafana integration exists. Health endpoints are real and
reasonably granular (`/api/health`, `/api/health/database`,
`/api/health/redis`, `/api/health/whatsapp`, `/api/health/ai`,
`/api/health/goose`) — but nothing polls them externally, so a silent
degradation between checks goes unnoticed by anyone.

- **Zero-budget fix**: Sentry free tier (5k events/mo) for exceptions;
  UptimeRobot free tier polling the health endpoints for uptime/downtime
  alerts. Both genuinely free at bootstrap scale.

### 4.4 Secrets management — adequate for one host, not further

`.env` is correctly gitignored, `.env.example` is the allow-listed
template, and a targeted search confirmed no secret was ever committed to
history. `docker-compose.yml` sources secrets via a plain `env_file`,
explicitly documented in its own header as not real Docker/Swarm/K8s
secrets management. This is fine for a single bootstrapped host; it is a
real gap the moment the deployment goes multi-host.

- **Zero-budget fix**: none needed right now — `chmod 600` on the host
  `.env` is the only free hardening left. A real secrets vault is later
  work, tied to the Stage 1 cloud migration already scoped in the
  cloud/WhatsApp audit.

### 4.5 Abuse protection

Login already has real brute-force throttling (8 failures/15min) plus a
global 300 req/min/IP limiter across all of `/api` — this is solid,
already-shipped protection, not a gap. The genuine gaps: no rate limit on
registration (relevant the moment self-serve signup exists, §2), and no
connection-flood cap on the WebSocket server — a per-IP connection
counter in the existing `connection` handler closes this for free.

### 4.6 Dependency security & CI/CD

`docs/legal/dependency-and-license-audit.md` exists and is reasonably
fresh (~8 days old at last check) but is explicitly a *licensing* audit,
not a vulnerability scan — no `npm audit`, no Snyk, no Dependabot config.
Several dependencies (including the unused `pino`) are pinned to
`"latest"`, meaning the exact shipped version can silently drift between
installs. `.github/` doesn't exist at all — `typecheck`/`test`/`build`
are real scripts that only ever run manually; nothing gates a broken
build before it reaches `main`.

- **Zero-budget fix**: GitHub Actions free tier (effectively unlimited
  for a small private repo) running typecheck+test+build on every PR,
  plus `npm audit` as a step, plus Dependabot (free on GitHub for any
  repo) for automated update PRs. Pin `"latest"` dependencies to real
  versions while you're in there.

### 4.7 TLS

The app listens on plain HTTP with no TLS termination of its own, and
`helmet()`'s HSTS configuration only makes sense in front of TLS — but
nothing in the docs states who's supposed to terminate it. Not a code
gap, a documentation-and-deployment gap that's easy to get wrong on a
first solo deploy.

- **Zero-budget fix**: Caddy (free, automatic Let's Encrypt certificates)
  or Cloudflare's free tier in front of the app, plus one explicit
  sentence in `docs/DOCKER.md` stating the assumption.

---

## 5. Cross-cutting trends observed

A few patterns showed up independently across all three research passes,
worth naming because they should change *how* future phases get built,
not just *what* gets built next:

1. **Proven patterns exist but stop halfway.** `EncryptionService` is
   real and tested — applied to 5 tables, then simply not extended to
   4 more that were built later. The BullMQ scheduled-sweep pattern is
   real and tested — applied to 9 reconciliation jobs, never once to a
   deletion job, even though the one TTL column that exists already has
   a working (just unwired) sweep method sitting in the repository
   layer. The lesson: when a new table/feature is added, "does this need
   the encryption/retention treatment the rest of the app already has"
   should be a checklist item, not something that waits for its own
   audit to notice.
2. **The tenant-isolation layer is trustworthy except at its oldest
   edges.** `requireAuth` → membership → `businessId` is correct nearly
   everywhere; the two exceptions (§4.1) are both auth call sites that
   predate the membership system and were never migrated when it landed.
   Anything else in this codebase written *before* a foundational system
   existed is worth a quick grep for the same pattern.
3. **The two things standing between this app and "real SaaS" are both
   about trust, not features**: can you prove the system won't lose
   data (backups, monitoring — §4.2-4.3), and can you actually collect
   money (§2.2's one non-free line item). Everything else audited here
   is comparatively mechanical.
4. **Almost none of this needs money.** Of everything found across all
   three passes, exactly one item — payment collection — has no
   realistic free path. Everything else is engineering time against
   free tiers already named above.

---

## 6. One merged, prioritized roadmap

Ordered by risk × cost, not by which audit found it. Every item here is
free unless marked otherwise.

**Tier 0 — before onboarding a second business, full stop (hours, not
days):**
1. Fix `login()`/`GET /api/auth/me` to resolve business via
   `membership.businessId` (§4.1) — the cross-tenant leak landmine.
2. Nightly `pg_dump` + WhatsApp session volume backup to a free-tier
   object store (§4.2).

**Tier 1 — closes the loudest silent-failure and data-hygiene gaps
(days):**
3. Wire `sweepExpiredRawEvents` into the existing scheduler (§3.3) —
   already-built code, just needs connecting.
4. Encrypt `notifications.title/body`, `crm_contacts.notes/ai_summary`,
   `leads.notes/next_action`, `campaigns.message_text` via the existing
   `EncryptionService` (§3.2) — mechanical, proven pattern.
5. Add retention/purge sweeps for notifications, security audit logs,
   and revoked/expired sessions (§3.2-3.3).
6. Sentry free tier + UptimeRobot polling `/api/health*` (§4.3).
7. GitHub Actions CI (typecheck+test+build+`npm audit` on PRs) +
   Dependabot (§4.6).
8. TLS termination via Caddy or Cloudflare, documented explicitly
   (§4.7).
9. WebSocket per-IP connection cap (§4.5).

**Tier 2 — the actual "app + website to sign up" build (the real
feature work, days-to-weeks):**
10. Cloud Architecture Stage 1 from the existing cloud/WhatsApp audit —
    managed Postgres/Redis on free/cheap tiers (Neon or Supabase free
    Postgres, Upstash free Redis), secrets out of `.env`. Genuinely
    buildable at $0-low-cost for a bootstrap-scale deployment.
11. Public marketing/landing page + real multi-business signup flow
    (business name, plan picker, `businessRepository.create()`) wired to
    the existing `plans`/`subscriptions` schema (§2.2).
12. Transactional email (Resend or SES free tier) for verification and
    password reset (§2.2).
13. Cloudflare Turnstile + registration rate-limiting on the new public
    form (§2.2).

**Tier 3 — needs a real decision, not just engineering time:**
14. Payment processor integration (Stripe or similar) — deferrable:
    launch on trial-only or manually-invoiced signup first, add this
    once there's a paying customer to justify it.
15. Real cloud KMS to replace the local master-key stand-in (§4.4).
16. WhatsApp connection Stage 2 (singleton → keyed map) — only needed
    once Tier 2's signup flow actually produces a second connected
    business; trigger conditions already defined in the cloud/WhatsApp
    audit.

This folds cleanly into the order `ARCHITECTURE_STATUS.md` already had
agreed: Tier 0-1 items are new and belong *ahead* of everything
previously queued (they're cheap and each closes a real production risk
that gets worse the longer it waits). Tier 2 *is* "Cloud architecture
Stage 1" from the existing order, made concrete with actual free-tier
provider names. The previously-agreed key-rotation-with-versioning work
and WhatsApp Stage 2 refactor still belong where they were — after the
signup flow exists to actually need them.

---

## 7. What this document deliberately does not decide

- No specific KMS or cloud provider is chosen (Neon/Supabase/Upstash
  named above as bootstrap-friendly examples, not a commitment).
- No payment processor is chosen — that's a real business decision
  (fees, supported countries, tax handling) deserving its own
  conversation when revenue is close.
- No implementation code, migration, or schema change is written here —
  per this engagement's established discipline, each Tier above gets its
  own explicit authorization before work begins, same as every prior
  phase.

---

## 8. On the product framing ("the perfect employee")

One brief note, since it was part of how this audit was framed: nothing
above requires re-architecting for the "streamline work, don't replace
workers" positioning — that's a product/marketing framing decision, not
a gap this audit found. The one place it's worth being deliberate is the
privacy policy and public-facing copy for the Tier 2 signup flow: the
Telegram/ProtonMail-level privacy commitment (§3) and the Gemini
third-party-exposure fact (§3.4) are both things a business signing up
to let this app act as their "employee" would reasonably want stated
plainly, not discovered later.
