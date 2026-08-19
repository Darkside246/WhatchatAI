# ADR-001: WhatsApp Connector Selection

**Status**: Accepted (confirms an existing, already-implemented decision — this ADR formalizes it with source-verified evidence rather than changing it)

## Context

WhatchatAI needs to maintain a persistent, unofficial WhatsApp Web session
per connected business account, capable of real-time inbound sync and
(eventually) outbound sending, at a cost structure that works for a
multi-tenant SaaS running many concurrent accounts. Two real unofficial
connectors were evaluated, plus one officially-connected reference
(Chatwoot, which uses neither):

- `@whiskeysockets/baileys` — the connector already in use
- `whatsapp-web.js` — evaluated per this session's directive
- Chatwoot's `Channel::Whatsapp` (Meta Cloud API / 360dialog) — inspected as a third data point, not a candidate (it requires official Business API onboarding, which is a different product decision entirely, not a drop-in connector swap)

Full comparison: `docs/reference/whatsapp-connector-comparison.md`.

## Decision

**Keep Baileys.** No connector change.

## Rationale (source-verified, not assumed)

1. **Resource cost per tenant.** Confirmed from source: Baileys is a
   direct WebSocket client (`node_modules/@whiskeysockets/baileys/lib/Socket`)
   with no browser dependency. whatsapp-web.js (confirmed from its
   `package.json` and `src/Client.js`) launches a full headless Chromium
   instance per session via Puppeteer and drives WhatsApp's own internal
   web-client JavaScript modules. For a SaaS running potentially dozens or
   hundreds of concurrent WhatsApp accounts, one Chromium process per
   account is not viable; Baileys' ~50-150MB-per-session footprint is.
2. **`@lid` support.** Baileys has native, working support for WhatsApp's
   `@lid` identity system (`key.remoteJidAlt`), already the backbone of
   WhatchatAI's honest identity-reconciliation model
   (`whatsapp_jid_mappings`). No equivalent was found in whatsapp-web.js's
   inspected public structures.
3. **Already the working, tested foundation.** Baileys already backs 29
   migrations' worth of real, tested WhatsApp functionality. Replacing it
   would mean rewriting a large, working system to solve a problem
   (resource cost, `@lid`) that Baileys already handles better than the
   alternative.
4. **Chatwoot's approach is not a real alternative for this decision** —
   it requires Meta Business API onboarding and message templates, which
   is a fundamentally different product (official Business Solution
   Provider integration) rather than a connector swap. This was confirmed
   by reading `app/models/channel/whatsapp.rb` directly, not assumed from
   Chatwoot's marketing.

## Consequences

- WhatchatAI remains dependent on an unofficial protocol implementation,
  carrying the same "WhatsApp could break this with a protocol change"
  risk it always has — this is inherent to the unofficial-connector
  category, not specific to Baileys vs. whatsapp-web.js (whatsapp-web.js
  carries an analogous risk from WhatsApp Web frontend changes).
- Two connector-level gaps are accepted rather than chased: album/GIF-set
  grouping and WhatsApp Business commerce message types (order/product/
  payment), because neither Baileys nor a connector swap changes whether
  the underlying proto fields are exposed at the layer WhatchatAI
  currently consumes.
- If Meta's official Business API ever becomes a product requirement
  (e.g., for message-template-based outbound campaigns, or a customer
  explicitly wants official-API compliance over an unofficial connection),
  that is a **separate, additive integration**, not a replacement for
  Baileys — the two serve different product tiers.

## Alternatives considered and rejected

| Alternative | Rejected because |
|---|---|
| whatsapp-web.js | Chromium-per-session resource cost incompatible with multi-tenant scale; no confirmed `@lid` support |
| Meta WhatsApp Business Cloud API (Chatwoot's model) | Requires Business verification + message templates for business-initiated conversations; not a like-for-like replacement for an unofficial personal-session connector — a different product decision |
| Running both Baileys and whatsapp-web.js | Explicitly ruled out by the directive ("do not run two independent WhatsApp engines"); no capability gap found that would justify the operational complexity of two authentication systems, two QR systems, two inbound pipelines |

## Links

- `docs/reference/whatsapp-connector-comparison.md` — full capability table
- `docs/reference/whatsapp-feature-map.md` — feature-by-feature support matrix
- `docs/legal/dependency-and-license-audit.md` — Baileys license confirmation (MIT)
