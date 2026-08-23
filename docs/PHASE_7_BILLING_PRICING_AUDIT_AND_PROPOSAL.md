# Phase 7: Billing, Fees, Taxes, Pricing — Audit and Proposal

**Status: read-only audit + design proposal. No code, schema, or
configuration changes in this document.** Mirrors this engagement's
established workflow (Phase 2A, Phase 3A): audit → proposal → review gate
→ implementation. Nothing in this document is authorized for
implementation yet — several sections below end in an explicit decision
point that only the business owner can resolve, not a default I've picked
on my own.

---

## 1. Current state, traced

The plan/entitlement/subscription foundation was built early in this
engagement (Phase 2C) as SaaS scaffolding, before Phase 7 was ever
scoped. It is more solid than "scaffolding" usually implies, but it is a
**capability-limits system, not a billing system**.

**Schema** (migrations `017`–`021`, seeded in `025`, extended in `041`/
`055`/`067`):

- `plans` — `plan_key`, `name`, `price_monthly_cents`, `price_yearly_cents`,
  `currency` (flat `'USD'` default). No tax/fee columns.
- `plan_entitlements` — per-plan `(entitlement_key, limit_value)`, `NULL`
  limit = unlimited.
- `subscriptions` — one live row per business, `status` CHECK-constrained
  to `ACTIVE/TRIALING/PAST_DUE/PAUSED/CANCELLED/EXPIRED`, a partial unique
  index enforcing at most one live subscription per business.
  `payment_provider`/`payment_customer_id`/`payment_subscription_id`
  columns exist but are **never populated by any code path** — pure
  placeholders from the original design.
- `subscription_events` — real audit-log table and repository, but
  **nothing writes to it in production code**; `subscriptionRepository
  .updateStatus` doesn't log an event, so this table is currently inert.
- `usage_counters` — period-bucketed `(business_id, metric_key,
  period_start)` counters with a real, correct UPSERT
  (`usageCounterRepository.increment`). **Zero call sites anywhere in
  `src/` outside the repository file itself** — nothing increments it in
  response to a message send, an AI reply, or any other real event. Fully
  dead code today.

No `invoices`, `payments`, `tax_rates`, `fees`, `discounts`/`coupons`, or
`line_items` tables exist anywhere in the schema.

**Enforcement** (`EntitlementService`, six methods): five of six are real,
server-side, and tested — `canCreateAgent`, `canCreateCampaign`,
`canActivateFunnel`, `canCreateKnowledgeBaseDocument`,
`canCreateBusinessDocument` are all actually called from their respective
create paths and deny over-limit requests. **`canConnectWhatsAppAccount`
is the one exception: it exists and is unit-tested in isolation, but
`whatsappConnectionService`'s real connect path never calls it.** A
business today can connect unlimited WhatsApp accounts regardless of
plan — the only real, live entitlement gap in this system.

None of these checks read `usage_counters` — they count live rows in the
owning table directly (agents, campaigns, funnels, documents), which is
why the counters table has stayed unused since it was built: it was never
load-bearing for anything.

**Billing surfaces** (`workspaceService.getBillingOverview`/
`getPlanCatalogue`, `BillingRoute.tsx`): genuinely read real data, no
mocking. The frontend is deliberately, honestly read-only — it shows an
"Info" banner (`selfServeChangeAvailable: false`, with the stated reason
"No payment provider is connected yet, so plan changes are handled
manually") instead of a fake Upgrade button. There is no payment
provider integration anywhere in the codebase — no Stripe or any other
PSP package in `package.json`, no checkout flow, no invoice list.

## 2. Findings

1. **One real, live enforcement bug**: `canConnectWhatsAppAccount` is
   dead code at its one call site's absence. Low-risk, self-contained fix
   — wire it into `whatsappConnectionService`'s connect path, matching
   the pattern every other entitlement check already uses.
2. **No payment collection exists.** This system cannot charge a real
   customer today, by design (deliberately deferred, not an oversight —
   the frontend's own copy says so).
3. **No tax calculation of any kind.** Not even a stub. `fees`,
   `taxes`, and `pricing` in the directive's Phase 7 name have zero
   representation in code or schema today.
4. **`usage_counters` is schema-complete but entirely disconnected**
   from real traffic. If any part of the intended pricing model is
   usage-metered (per-message, per-AI-reply, per-active-agent-hour,
   etc.), that metering does not exist yet.
5. **No plan-change, renewal, dunning, or trial-expiry lifecycle** exists
   in code — `subscriptions.status` can only ever be `TRIALING` (the
   only status any code path sets), because `ensureDefault` is the sole
   writer and nothing transitions it further.
6. **`docs/PRODUCTION_READINESS_DIRECTIVE.md` never elaborates Phase 7**
   beyond the one `ARCHITECTURE_STATUS.md` row ("should become its own
   isolated, deterministic pricing/calculation domain — not scattered
   across the app"). There is no existing scope beyond that one sentence
   for this proposal to be checked against.

## 3. Scope decision: what this proposal covers, and what it deliberately doesn't

Finding 2 above is the crux of why this has to stay a proposal rather
than jump straight to a build: **actually charging money requires
business decisions I cannot make on this engagement's behalf** — which
payment processor, which currencies and tax jurisdictions this business
actually operates in, what the real tax treatment is (US sales tax by
state, EU VAT, or something else entirely), what the refund/dunning
policy is, and what credentials this deployment will hold. Building
against invented answers to any of those would produce code that looks
finished but is wrong the moment it meets a real customer and a real
tax authority — the same category of mistake this whole engagement has
been correcting elsewhere (fabricated success, decorative enforcement).

So this proposal is split into two tracks:

**Track A — buildable now, no external decisions required.** A real,
isolated, deterministic pricing/calculation domain that computes what a
business *owes* (plan price + any usage overage + configured fees, minus
discounts, is a pure function of plan + usage + a tax-rate table) without
touching money movement. This is genuinely "its own isolated domain" per
the directive, testable with ordinary unit tests (no mocked HTTP, no
sandbox payment provider), and it closes findings 1 and 4 as natural
side effects. Sections 4–6 below fully specify Track A.

**Track B — blocked on your decisions.** Actually collecting payment
(a real PSP integration), real tax-jurisdiction compliance (a
maintained, correct tax-rate source — not a hand-rolled table, since
rates change and getting this wrong is a legal/compliance problem, not
just a bug), invoice delivery (email/PDF), and subscription lifecycle
automation (renewal, dunning, cancellation-on-payment-failure). Section
7 lists the specific questions that need your answer before any of this
is scoped further, let alone built.

## 4. Proposed schema (Track A)

Four new tables, all business-scoped and additive — nothing above
changes shape, only gains new relationships:

```sql
-- One row per billing period per business: the deterministic output of
-- the pricing engine, computed and stored (never recomputed silently
-- after the fact - a past invoice must stay exactly what it said).
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'FINALIZED', 'PAID', 'VOID')) DEFAULT 'DRAFT',
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL,
  subtotal_cents BIGINT NOT NULL,
  tax_cents BIGINT NOT NULL DEFAULT 0,
  discount_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Line items, so "what am I being charged for" is always inspectable -
-- never a single opaque total.
CREATE TABLE invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  kind TEXT NOT NULL CHECK (kind IN ('PLAN_BASE', 'USAGE_OVERAGE', 'FEE', 'DISCOUNT')),
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 1,
  unit_amount_cents BIGINT NOT NULL,
  amount_cents BIGINT NOT NULL, -- quantity * unit_amount_cents, stored not recomputed
  metric_key TEXT -- set only for USAGE_OVERAGE rows, references usage_counters.metric_key
);

-- Explicit, versioned, config-driven rates - NOT a live tax API call.
-- Deliberately simple (flat percentage per jurisdiction code) because a
-- correct, current, comprehensive tax table is a Track B compliance
-- decision, not something to fabricate here.
CREATE TABLE tax_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_code TEXT NOT NULL, -- e.g. an ISO country code, or country-subdivision
  rate_bps INTEGER NOT NULL CHECK (rate_bps >= 0), -- basis points, avoids float rounding
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ, -- NULL = still current
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-plan or per-business fee/overage pricing, so the engine never has
-- a hardcoded dollar figure buried in application code.
CREATE TABLE pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES plans(id), -- NULL = applies to every plan
  metric_key TEXT NOT NULL, -- matches usage_counters.metric_key / plan_entitlements.entitlement_key
  unit_amount_cents BIGINT NOT NULL,
  included_quantity NUMERIC NOT NULL DEFAULT 0, -- free allowance before overage applies
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`businesses` gains one nullable `tax_jurisdiction_code TEXT` column (set
during onboarding/settings, not guessed from IP or phone number — an
explicit operator input).

## 5. Proposed pricing engine (Track A)

A new `src/services/billing/pricingEngine.ts`, deliberately isolated
from `workspaceService` per the directive's own instruction — every
other domain reaches it through a narrow interface, never reimplements
a calculation:

```ts
interface PricingInput {
  businessId: string;
  subscriptionId: string;
  planId: string;
  periodStart: Date;
  periodEnd: Date;
}

interface PricingResult {
  lineItems: LineItem[]; // PLAN_BASE, one per over-allowance metric, any active discount
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

function computeInvoice(input: PricingInput): Promise<PricingResult>;
```

Pure and deterministic given its inputs: plan base price
(`plans.price_monthly_cents`), each metered overage (real
`usage_counters` count for the period minus `pricing_rules
.included_quantity`, multiplied by `unit_amount_cents`, only for metrics
that have a `pricing_rules` row — most plans stay flat-rate with zero
overage rows), and tax (`tax_rates` row matching the business's
`tax_jurisdiction_code` and effective on `periodEnd`, applied to
`subtotalCents`). No network call, no external pricing decision made at
compute time — everything it needs is already in Postgres. This is
what makes it unit-testable the same way `keyStabilityCheck.ts` or the
media retry state machine are: real Postgres, no mocked HTTP boundary
needed at all here (there is no HTTP boundary in Track A).

Invoice generation itself (`invoiceService.finalizeInvoice(businessId,
periodStart, periodEnd)`) calls `computeInvoice`, writes one `invoices`
row plus its `invoice_line_items` in a transaction, and stops at
`status = 'FINALIZED'` — it never attempts to collect payment (that's
Track B). A finalized invoice is real, inspectable proof of what a
business owes; whether it ever gets paid is out of scope here.

## 6. Proposed usage-metering wiring (Track A)

Closes finding 4. `usageCounterRepository.increment` is already correct
— it just needs real call sites. Candidates, one `.increment()` call
each, at the point the real underlying action already happens (never a
separate reconciliation pass that could drift from reality):

- `whatsappOutboundMessageService.send` → `metric_key = 'messages_sent'`
- `aiReplyService.generateAiReply` on a real `'generated'` outcome →
  `metric_key = 'ai_replies_generated'`
- `whatsappConnectionService`'s connect success → `metric_key =
  'whatsapp_accounts_connected'` (this one doubles as the fix for
  finding 1, once `canConnectWhatsAppAccount` is also wired in
  alongside it)

Each of these three is naturally business-scoped and already happens
exactly once per real event (no risk of double-counting from a retry,
since the surrounding code already has its own idempotency guards from
earlier phases — Phase 3B's outbound-send boundary, Phase 2B's guarded
media state machine's equivalent for messages). Metrics with no
`pricing_rules` row simply accumulate for visibility/future use without
ever appearing on an invoice.

## 7. Track B — open questions that block further scoping

These are not implementation details I can default my way past; each
has real consequences (money, legal compliance, customer trust) and
needs your answer before I write a Track B proposal:

1. **Payment processor.** Stripe is the obvious default for a SaaS this
   shape, but it's your call — different processors have different
   payout timelines, supported countries, and fee structures.
2. **Which currencies and countries does this business actually operate
   in?** `tax_rates` (§4) is designed to hold real rates, but I have no
   authority to decide what those rates are, or which jurisdictions
   matter — that's either manual entry by you/your accountant, or a
   maintained third-party source (e.g. Stripe Tax, TaxJar) if the
   jurisdiction spread is too large to hand-maintain safely.
3. **Trial/dunning policy.** How many days trial, what happens on
   payment failure (grace period? immediate `PAST_DUE`? auto-downgrade
   to a free tier if one exists?), and how many retries before
   cancellation.
4. **Invoice delivery.** Email + PDF? A hosted invoice page? Does this
   need to integrate with `src/services/ai/` email system (Phase 6,
   also not started) or stay independent?
5. **Is there a free tier at all**, or does every business require an
   active paid plan from signup? (`ensureDefault`'s 14-day trial is the
   only existing default today, and there's no seeded free plan.)

## 8. What Track A would actually touch (if authorized)

- **Migration**: the four new tables in §4, plus the one nullable
  `businesses.tax_jurisdiction_code` column.
- **New service**: `src/services/billing/pricingEngine.ts` (pure
  calculation) and `src/services/billing/invoiceService.ts`
  (persistence, transactional).
- **Fix**: wire `canConnectWhatsAppAccount` into
  `whatsappConnectionService`'s connect success path (finding 1).
- **New call sites**: three `usageCounterRepository.increment` calls
  (§6) at existing real-event boundaries — no new event types invented.
- **API**: a read-only `GET /api/workspace/billing/invoices` (list) and
  `GET /api/workspace/billing/invoices/:id` (detail, with line items),
  matching the existing `getBillingOverview` read-only convention — no
  write/checkout endpoint, since there is nothing to check out into yet.
- **Frontend**: an Invoices tab/section on the existing `BillingRoute`,
  read-only, same honest-about-its-own-limits posture as today's page.
- **Explicitly not touched**: no payment collection, no Stripe/PSP
  package added, no subscription-status-changing automation, no email
  delivery.

## 9. Regression test plan (for Track A, if authorized)

1. `computeInvoice` for a plan with no overage-priced metrics — result
   is exactly `plans.price_monthly_cents`, zero tax if no
   `tax_rates` row matches, zero line items beyond `PLAN_BASE`.
2. A metric with real usage above its `pricing_rules.included_quantity`
   produces exactly one `USAGE_OVERAGE` line item with the correct
   `(usage - included) * unit_amount_cents`.
3. Usage at or below `included_quantity` produces **no** overage line
   item (never a zero-amount row cluttering the invoice).
4. A `tax_rates` row effective for the invoice's `periodEnd` is applied
   correctly to the subtotal in basis points (no float rounding drift
   — assert exact integer cents).
5. No matching `tax_rates` row for the business's jurisdiction → tax is
   exactly zero, never an error (a business with no configured
   jurisdiction is a valid, common state, not a failure).
6. Two overlapping `tax_rates` rows for the same jurisdiction (a rate
   change) — the engine picks the one whose `effective_from`/
   `effective_to` window actually contains `periodEnd`, never both.
7. `finalizeInvoice` is idempotent for the same `(businessId,
   periodStart, periodEnd)` — calling it twice never produces two
   invoices for the same period.
8. Cross-tenant: an invoice/line-item read for a business other than
   the authenticated one is refused identically to a nonexistent id,
   matching this engagement's standing `findByIdForBusiness` convention.
9. The three new `usageCounterRepository.increment` call sites (§6)
   each produce exactly one increment per real event, verified against
   the same real-Postgres/mocked-external-boundary pattern as
   `mediaRetryStateMachine.test.ts` (only Baileys/Gemini calls mocked,
   everything else real).
10. `canConnectWhatsAppAccount` enforcement: a business at its
    `max_whatsapp_accounts` limit is refused a new connection with the
    same `ENTITLEMENT_DISABLED`/limit-exceeded shape every other
    entitlement check already returns — mirrors the adversarial
    cross-tenant/entitlement test pattern from
    `test/entitlementService.test.ts`.

---

**Recommendation**: authorize Track A as its own implementation phase
(it's genuinely self-contained, closes two real gaps, and needs no
business decisions I can't make from the code alone), and treat Track B
as blocked until you've answered §7 — there's no version of "billing
that can actually charge a customer" that's safe to build on invented
answers to those five questions.
