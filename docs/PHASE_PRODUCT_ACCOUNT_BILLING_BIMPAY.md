# Product Account Billing + BiMPay Bridge Phase

## Pre-phase assessment

The platform-account phase established isolated product accounts, product entitlements, a 48-hour trial state machine, server-side restriction after expiry, and developer-only control-plane access. The remaining commercial gap was that subscriptions were not explicitly owned by product accounts and there was no safe payment/reactivation workflow.

For Barbados-first deployment, BiMPay is treated as a payment rail rather than as an assumed public SaaS webhook API. The application therefore implements a provider adapter and authenticated automation bridge. A bank/email notification automation can call the bridge after a confirmed transfer. The application never treats an unverified client claim as a payment confirmation.

## Phase build

- Product-account-scoped subscriptions.
- BBD as the default commercial currency while retaining a provider abstraction.
- Monthly, annual and one-time billing intervals.
- Unique checkout references such as `SAAS-A1B2C3`.
- BiMPay checkout instructions requiring the generated reference in the transfer memo/reference field.
- Payment attempts with explicit lifecycle state.
- Provider event idempotency protection.
- Exact amount and currency verification before activation.
- HMAC-authenticated BiMPay automation bridge using `BIMPAY_BRIDGE_SECRET`.
- Automatic reactivation of a restricted product account only after verified payment.
- Trial entitlements converted from `TRIAL` to non-expiring `PLAN` entitlements after verified payment.
- Client payment-proof submission for bank/notification failures or missing references.
- Developer-only payment-proof review and approval/rejection.
- Payment audit events and provisioning reactivation events.
- Payment-proof ownership checks so a client cannot submit proof against another product account's payment attempt.
- Billing routes mounted beneath `/api/billing`.

## Post-phase assessment

The commercial boundary is now:

`Product Account -> Subscription -> Payment Attempt -> Provider Verification -> Account Reactivation`

A BiMPay transfer cannot activate an account using only a screenshot, client-side request, or guessed reference. The bridge requires a server secret, the checkout reference must exist, the provider must match, the provider event is idempotent, and the received amount/currency must exactly match the checkout.

The system also deliberately does not represent the automation bridge as a native BiMPay webhook. This keeps the implementation honest and allows the bank notification mechanism to be replaced later by an official provider integration without changing the client billing contract.

## Next-phase gate

Before production payment activation, configure the real bank notification automation and `BIMPAY_BRIDGE_SECRET`, validate the exact bank notification fields, test duplicate notifications, wrong amounts, missing references, and delayed notifications, and run the complete PostgreSQL-backed integration suite.

The next architectural phase should add the customer-facing billing UI and paid-account lifecycle screens, then complete authentication recovery/password completion for trial-created identities.
