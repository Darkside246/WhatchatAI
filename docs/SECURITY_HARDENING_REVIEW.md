# Security hardening review

A read of this application looking for ways in, and for the places where a
rule everybody believes is true is not actually enforced by anything.

Six findings, all fixed. Two privilege escalations and an enforcement gap in
the first pass; the alerting, monitoring and rate-limiting gaps that pass
left behind in the second. One recommendation is still open, at the bottom.

Nothing here was inferred from a scan: every finding was traced to the line
that allows it, and every fix was checked by removing it again and confirming
a test fails.

---

## What was fixed

### 1. Anyone signed in could take over the WhatsApp control channel — critical

`src/server/operatorModeRouter.ts` applied `requireAuth` and nothing else.

Operator mode is the WhatsApp-side control channel. Whoever holds the
configured phone number and PIN can, from their own phone and entirely
outside this app, read the business's takings, change an invoice's status,
log incidents, read the message queue and **switch the AI off**
(`operatorCommandService.ts`, `executeCommand`).

`POST /api/operator-mode/settings` sets both the number and the PIN, and it
was reachable by any member of the business. That includes `VIEWER` — a role
whose entire permission set is the nine `*.view` keys, and whose whole
purpose is that it cannot change anything
(`src/domain/auth/permissions.ts`).

So the lowest-privileged role in the product could point the control channel
at their own phone and drive the business's WhatsApp. Being signed in was
the only check standing in the way.

**Fixed:** every mutating route in that router now requires
`settings.manage`, held by `OWNER` and `ADMIN` only. Reading whether
operator mode is configured is still open to any member. The app's own
Settings screen already gated this to OWNER/ADMIN in the browser
(`SettingsRoute.tsx:920`) — the server simply never agreed with it, which is
the classic shape of this bug.

### 2. Anyone signed in could approve, send, pay, void or delete an invoice — high

`src/server/invoiceRouter.ts`, same cause: `requireAuth` and
`requireActiveSubscription`, no permission check on any of its ten mutating
routes. A `VIEWER` could approve an invoice, mark it paid, send it to a
customer, void it or delete it.

**Fixed:** all ten now go through `canManageInvoices()`
(`src/domain/auth/invoiceAccess.ts`). Reads are deliberately untouched — a
colleague looking at a document their own business issued was never the
problem.

**And it is a setting, not a decision made once for everybody.** "Who may
raise an invoice" is a real difference between businesses rather than a fact
about software: a restaurant where the owner does the books wants it locked
down, while a property firm with a manager running the office needs that
manager invoicing without being made an admin of everything else. So
Settings carries *Let managers raise and settle invoices*:

- **Off by default** (migration 1052) — exactly the locked-down state, so
  nobody's access changes the day this ships. The opposite default would
  quietly re-open the hole the review just closed.
- **On** extends invoice management to `MANAGER` and `SUPERVISOR` and to
  nobody else. `AGENT`, `MARKETING` and `VIEWER` never reach it however the
  setting is set — a delegation widens the circle of trusted people, it does
  not open the door.
- **Changing it requires `settings.manage`**, which the delegated roles do
  not hold, and the control is not rendered for them either. This is the
  load-bearing part: a manager who could switch on manager invoicing has not
  been delegated anything, they have found an escalation, and the setting
  would be worse than no setting at all.

### 3. The test that guards against exactly this read 3 of 20 routers

`test/routeAuthorization.test.ts` existed to catch an unguarded mutating
route. It read `index.ts`, `productAccountRoutes.ts` and
`oversightRoutes.ts` — while `platformRoutes.ts` mounts twenty routers.

Food operations, invoices, billing, the driver portal, operator mode,
property and retail operations, the OAuth routers: roughly a hundred
mutating routes outside the sweep, carrying their guards by convention. Two
of those files turned out not to carry them at all, which is how findings 1
and 2 survived.

**Fixed:** the sweep now covers every router file. A route is accepted when
the file guards the whole router, guards the prefix it sits under, or guards
the route line — otherwise it must be named in an explicit public allowlist
with its reason. Nine routes are on that list today (signature-verified
payment webhooks, driver token exchange and sign-out, public consent
capture, public signup), each verified by hand.

The sweep was tested by removing a guard and confirming it fails, so it
cannot pass vacuously.

---

## Also fixed, in a second pass

### 4. Security events were recorded but nobody was told — FIXED

`security_audit_logs` faithfully records every screening block, leak block
and rate-limit trip, and the oversight sweep
(`services/oversight/oversightSweepService.ts`) genuinely *detects* abuse
from them — auth rate-limit trips already raised a real, correctly-scored
finding.

Then it stopped. `raiseOrBumpFinding` wrote the row, wrote an audit event,
and returned. Nothing was dispatched anywhere, while
`incidentAlertService.ts` had a fully built email-and-Telegram path used only
by database, Redis, queue and Goose health. So a credential-stuffing run
produced a correct severity-high finding that sat in a table until somebody
thought to open the developer console.

To be precise about the original finding: it was not that nothing detects
security events. It is that detection reached nobody, which makes it a log
rather than a control.

**Fixed:** `services/alerting/securityAlertDispatch.ts` — the missing wire,
and nothing more. Same two channels, same "never pretend an alert was sent"
honesty.

- **Critical and high only.** A medium finding is worth looking at during the
  day and a bad thing to be paged about at 3am; a channel that cries wolf is
  one people mute, which is worse than having none. Every severity is still
  written to `oversight_findings` and the audit log regardless — this decides
  only what gets pushed.
- **Deduped by the mechanism already there.** The dispatch sits in
  `raiseOrBumpFinding`'s brand-new branch, so a still-triggering condition
  bumps silently exactly as before, rather than paging every fifteen minutes
  for one outage.
- **After the record, never instead of it.** A dead mail provider costs a
  notification, never the finding — pinned by a test.
- **Its own module**, deliberately: `ALERT_MONITORING_ENABLED=false` turns
  off health polling and must not also silence security.

### 5. The Sentinel's second stage failed open, unwatched — FIXED

`security/sentinel/sentinel.ts:79` — when the AI screening stage is
unavailable the message is allowed through with a `sentinel_ai_unavailable`
audit row.

**The fail mode is unchanged, and deliberately so.** Stage 1's heuristic gate
still applies, and blocking every inbound message during a provider outage
would stop the business working. The trade-off is right. What was wrong is
that nobody watched it, so an outage silently downgraded screening to
heuristics-only for as long as it lasted.

**Fixed:** a new `security_screening` rule in the oversight sweep, which now
alerts by way of finding 4.

- `sentinel_ai_unavailable` above `sentinelUnavailablePerHour` (default 20)
  raises a finding; three times over makes it high, and pages. A handful of
  one-off timeouts stays quiet.
- `ai_output_leak_blocked` above `outputLeaksPerHour` (default 3) raises a
  separate one. Each of those is the guard working — which is exactly why a
  run of them means either somebody is probing or an agent's configuration is
  wrong.
- Counted platform-wide, not per tenant: the cause is one shared provider, so
  splitting it per business would report one incident as a hundred.
- The finding text says what is actually true — messages are still flowing
  and still heuristically screened — because "screening degraded" read at
  speed is easy to mistake for "messages stopped".

Both thresholds are editable in the developer control plane alongside the
existing ones.

### 6. The driver session exchange was missing from the auth rate limiter — FIXED

`POST /api/driver/session` trades a link token for a session cookie and was
covered only by the global 300/min per-IP limiter, not `authLimiter`
(10 per 15 minutes) like every other credential exchange.

The token is 32+ characters and compared as a hash, so this was an
inconsistency rather than a live hole. Two reasons it still mattered: "not
worth attacking today" is a property of the current token, not of the
endpoint; and the limiter is also the only thing that writes
`auth_rate_limited`, which is what the oversight sweep counts and now alerts
on. Without it, the driver door was the one credential endpoint nothing would
have noticed being hammered.

**Fixed:** added to `authLimiter`, registered in `index.ts` before
`mountPlatformRoutes()` — Express applies middleware in registration order,
so a limiter declared inside the router would have sat behind its own routes
and never run. That ordering is itself pinned by a test, since the failure
mode is a line of code and a test that both look correct while protecting
nothing.

---

## Still open

### 7. `tier_unrestricted` and developer-plane surface — worth a second read

Not a finding, a recommendation. `requireDeveloper` /
`requireDeveloperAdmin` guard a genuinely powerful surface (delete a
business, change any plan, extend any trial, grant `tier_unrestricted`).
The guards are present and tested. What is not tested is that a
`DEVELOPER` account cannot be created or promoted from inside an ordinary
business account. Worth pinning with a test, since it is the one boundary
where a mistake crosses tenants.

---

## Verified sound

Checked and found correct — recorded so a future review does not re-derive
it:

| Area | State |
|---|---|
| Security headers | `helmet` with a strict CSP: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`. No third-party script origins. |
| Rate limiting | Three tiers: 300/min global on `/api`, 30/min on AI/send endpoints, 10 per 15 min on auth, with a `auth_rate_limited` audit row. |
| Sessions | Opaque server-side tokens, `httpOnly`, `secure` when the request is, `SameSite=Lax`. No JWT to forge; nothing readable from script. |
| CSRF | `SameSite=Lax` plus no state-changing `GET` routes (the one `GET` that writes is a token-gated consent confirmation). |
| Payment webhooks | Unauthenticated by necessity, signature-verified in fact. HMAC over canonical fields, compared with `timingSafeEqual`, not a re-serialised body. Now enforced by a test. |
| SQL injection | Parameterised throughout. Every dynamic identifier traced: fixed column constants, literal union types, or a fixed key map. No user input reaches query text. |
| Media serving | Business-scoped lookup, MIME allowlist for `inline` with everything else `application/octet-stream`, `nosniff`, CRLF stripped from filenames. A hostile sender cannot get script into this origin. |
| Tenant isolation | `rowLevelSecurity`, `rowLevelSecurityExtended`, `tenantIsolation` test suites; repositories scope by `business_id` in the `WHERE` clause rather than checking after the read. |
| Logging | No phone numbers, JIDs, message text or names in any log line. `OutboundDispatchWorker` documents this explicitly. |
| Secrets | None committed. `MASTER_ENCRYPTION_KEY` has a boot-time stability check (`security/encryption/keyStabilityCheck.ts`) that refuses to start on a silent key change. |
| Dependencies | `npm audit`: 0 vulnerabilities, with and without dev. |
| AI provider access | `scripts/check-ai-call-sites.ts` allowlists every file that may reach the model directly, with a stated reason each, and runs in CI. |
| AI tool use | `agentGuard.guardToolInvocation` enforces registration, risk tier, per-tenant rate limits, the global pause switch and per-agent autonomy. |
| CI | `check:ai-call-sites`, `typecheck`, full test suite and build, on every push to the working branch. |

---

## What this review did not cover

Stated so the boundary is clear:

- **No live testing.** This is a read of the source, not a penetration test
  against the running droplet.
- **No infrastructure review.** SSH exposure, firewall rules, Docker
  configuration, TLS termination, database network exposure and backup
  encryption are outside it, and are where a review should go next.
- **No review of the Baileys fork.** The app pins a GitHub fork of
  `@whiskeysockets/baileys` at a specific commit. Pinning is right; nobody
  has read what is in that fork.
- **No cryptographic review** of the AES-256-GCM envelope itself, only of
  how the key is handled.
