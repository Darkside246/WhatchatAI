# Platform Account + Trial Foundation Phase

## Pre-phase assessment

The branch already had PostgreSQL migrations, persistent authentication sessions, business memberships, plan/subscription tables, AI agent registration, OpenClaw runtime boundaries, and property/food specialist work. The missing commercial boundary was a product-account model that could isolate Property and Food as separate customer tenants while allowing one user identity to own more than one product.

The existing subscription model is business-scoped, so it was not safe to reuse it as the product-account identity without introducing product isolation first.

## Build implemented

- Product catalogue with focused SaaS products.
- Product accounts with independent business/tenant IDs.
- Product entitlements with explicit source and optional expiry.
- Product-account provisioning with atomic PostgreSQL transactions.
- Provisioning event history.
- Normalised email trial identity.
- Database uniqueness enforcing one trial identity per email.
- 48-hour trial timing and deterministic state machine.
- Trial states: CREATED, ACTIVE, EXPIRING, EXPIRED, CONVERTED, CANCELLED.
- Trial onboarding transaction that creates the user, product business, membership, product account, trial entitlements and trial record without collecting payment information.
- Server-side trial session creation for onboarding.
- Platform role separated from business membership role.
- Developer-only control-plane API surfaces.
- Server-side product access middleware.
- Automatic transition to RESTRICTED when a trial has expired and operational access is requested.
- Property operations and property conversation binding routers protected by the Property product boundary.
- Developer email allowlist supported only from server configuration.

## Post-phase assessment

The architecture now has a clear boundary:

`User identity -> Product account -> Business tenant -> Product entitlements -> Product trial/subscription`

A client request cannot select another product simply by changing a product label. Product access is resolved against the authenticated user's membership and the PostgreSQL product-account record. Trial expiry is enforced server-side rather than relying on a frontend countdown.

The developer control plane is separate from client product APIs and is protected by a persisted platform role or server-side developer email allowlist.

## Remaining next-phase work

- Convert the existing generic subscription records to explicit product-account billing ownership.
- Add payment provider adapters and paid reactivation.
- Add password/magic-link completion for trial-created identities.
- Expand product access middleware to every product-specific operational router as each product surface is finalized.
- Add automated integration tests against PostgreSQL for race conditions around duplicate trial registration and expiry.
