# Security hardening review

A read of this application looking for ways in, and for the places where a
rule everybody believes is true is not actually enforced by anything.

Three findings were fixed in the same change as this document. The rest are
written down as real, open items with what each one would cost to close.
Nothing here was inferred from a scan: every finding below was traced to the
line that allows it.

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

## Open items

### 4. Security events are recorded but nobody is told — medium

`security_audit_logs` faithfully records `sentinel_ai_block`,
`sentinel_ai_unavailable`, `output_leak_blocked`, `auth_rate_limited` and
the rest. `src/services/alerting/incidentAlertService.ts` alerts on database,
Redis, queue and Goose health — **infrastructure only**. No security event
raises an alert to anybody.

That means credential stuffing against `/api/auth/login`, or an outbound
leak the guard caught, is visible only to somebody who opens the developer
console and looks. Detection without notification is a log, not a control.

**To close:** reuse the existing alert channels
(`alerting/alertChannels.ts` already does email and Telegram) with a rate
threshold per event type — a burst of `auth_rate_limited`, any
`output_leak_blocked`, a sustained run of `sentinel_ai_unavailable`. The
dedup and reminder machinery already exists in `incidentAlertService.ts`.

### 5. The Sentinel's second stage fails open, and nothing watches it — medium

`src/security/sentinel/sentinel.ts:79` — when the AI screening stage is
unavailable, the message is allowed through with a
`sentinel_ai_unavailable` audit row.

This is a deliberate, documented trade-off and the right one: Stage 1's
heuristic gate stays enforced, and blocking every inbound message during a
Gemini outage would stop the business working. But combined with finding 4,
a provider outage silently downgrades screening to heuristics-only for as
long as it lasts, and nobody finds out. The fix is not to change the fail
mode — it is to alert on it.

### 6. The driver session exchange has no dedicated rate limit — low

`POST /api/driver/session` trades a link token for a session cookie. It is
covered only by the global 300/min per-IP limiter, not by `authLimiter`
(10 per 15 minutes), which guards the other credential-exchange endpoints.

The token is 32+ characters and compared as a hash, so this is not
practically brute-forceable; it is an inconsistency rather than a live hole.
Adding it to `authLimiter` in `src/server/index.ts` is one line.

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
