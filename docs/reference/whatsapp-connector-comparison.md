# WhatsApp Connector Comparison — Baileys vs. whatsapp-web.js vs. Current WhatchatAI

Research method: both projects were actually cloned and their source
inspected directly (not just READMEs) — `@whiskeysockets/baileys` via the
exact installed package in `node_modules` (version `7.0.0-rc14`), and
`whatsapp-web.js` via a fresh shallow clone of
`https://github.com/wwebjs/whatsapp-web.js` (default branch at research
time). Chatwoot's own WhatsApp integration (`app/models/channel/whatsapp.rb`)
was also inspected as a third data point — see the note at the bottom.

## Fundamental architectural difference (the finding that matters most)

- **Baileys** reimplements WhatsApp's binary Noise-protocol/Signal
  WebSocket handshake directly in Node — confirmed from
  `node_modules/@whiskeysockets/baileys/lib/Socket/*`. No browser, no
  Puppeteer, no Chromium. A session is a WebSocket connection plus an
  in-memory/pluggable auth-state store.
- **whatsapp-web.js** launches a real headless Chromium via Puppeteer
  (`package.json`: `"puppeteer": "24.38.0"`; confirmed live in
  `src/Client.js`: `this.pupBrowser`, `this.pupPage`, `puppeteer.launch`-style
  calls), navigates to `web.whatsapp.com`, and calls WhatsApp's own
  *internal* frontend JavaScript modules from inside the page context
  (`window.require('WAWebSignalStoreApi')`, `WAWebUserPrefsInfoStore`,
  `WABase64`, `WAWebUserPrefsMultiDevice` — real internal WhatsApp Web
  module names, confirmed in `src/Client.js`). It is, architecturally, a
  browser-automation wrapper around WhatsApp's actual web client, not an
  independent protocol implementation.
- **Chatwoot** doesn't use either approach — `Channel::Whatsapp` (real
  file, `app/models/channel/whatsapp.rb`) talks to Meta's official
  **WhatsApp Business Cloud API** or **360dialog** (a Meta Business
  Solution Provider), both webhook-driven official APIs requiring Meta
  Business verification and message templates for business-initiated
  conversations. There is no QR-pairing, no personal-account session, and
  no unofficial-protocol code anywhere in Chatwoot's WhatsApp channel.

This third data point matters: Chatwoot's "channel" abstraction pattern
(`channel_id` + `channel_type` polymorphism across Email/API/WhatsApp/etc.)
is designed around official, webhook-pushed Business APIs — it doesn't
actually solve the problem WhatchatAI has (an unofficial, QR-paired,
personal-or-business-number, always-on socket connection). Copying that
pattern wholesale would be copying an abstraction built for a different
problem.

## Capability comparison

| Capability | Baileys (7.0.0-rc14, installed) | whatsapp-web.js (current) | Current WhatchatAI | Supported | Missing | Advantage | Risk | Recommendation |
|---|---|---|---|---|---|---|---|---|
| Connection model | Direct WebSocket, no browser | Puppeteer + real Chromium per session | Baileys direct WebSocket | Baileys: yes | — | Baileys: ~50-150MB/session vs. whatsapp-web.js's full Chromium process (several hundred MB-1GB+) — decisive for a multi-tenant SaaS running many concurrent accounts | Baileys reimplements the protocol itself, so a WhatsApp protocol change can break it until a new release ships; whatsapp-web.js inherits WhatsApp's own web client code so it can be more resilient to some internal changes, at a much higher resource cost per tenant | **Keep Baileys** — the resource-per-tenant difference alone rules out whatsapp-web.js for a commercial multi-account SaaS |
| Pairing | Real QR pairing, confirmed working (`src/services/whatsappConnectionService.ts`) | QR pairing via injected page script | Implemented, real | Yes | — | Equivalent | Equivalent | No change |
| Contacts/chats/groups sync | Real, confirmed via `contacts.upsert`/`chats.upsert`/`groups.upsert` events already wired | `ChatFactory`/`ContactFactory` equivalent | Implemented, real | Yes | — | Equivalent feature coverage | — | No change |
| Message types | `imageMessage`/`videoMessage`/`audioMessage`/`documentMessage`/`stickerMessage`/`buttonsMessage`/`listMessage`/`interactiveMessage`/`pollCreationMessage`/`contactsArrayMessage`/`groupInviteMessage`/`editedMessage`/`viewOnceMessage` (all confirmed handled in `whatsappMessageIngestionService.ts`) | `MessageTypes` enum (`src/util/Constants.js`) additionally has explicit `ALBUM`, `ORDER`, `PRODUCT`, `PAYMENT`, `SCHEDULED_EVENT_CREATION` as first-class types | Handles the Baileys set; `poll` classified but album/order/product/payment/scheduled-event are not | Mostly | Album grouping (already documented as deferred), WhatsApp Business commerce types (order/product/payment) | whatsapp-web.js's richer taxonomy reflects newer WhatsApp Business commerce features | Baileys' proto types are the real ceiling — if Baileys doesn't expose a commerce message field, there is nothing to classify regardless of which connector is used | Album support: real gap, worth a small dedicated pass later. Commerce types (order/product/payment): not worth chasing until WhatchatAI targets WhatsApp Business Catalog use cases |
| Media download | `downloadMediaMessage()` — real, already the backbone of the built media pipeline | Puppeteer-mediated download through the page's own decrypt routines | Fully implemented (real download, checksum, encrypted storage) | Yes | — | Equivalent capability, Baileys is lighter-weight | — | No change |
| Calls | Real `call` events (`offer`/`ringing`/`accept`/`reject`/`timeout`/`terminate`) — already wired to `whatsapp_calls` | `Call` structure exists (`src/structures/Call.js`) — `id`, `from` (`peerJid`), `timestamp` (`offerTime`), `isVideo`, `isGroup` | Implemented, real, with a documented 60s ring-timeout reconciliation job | Yes | Baileys still can't *place* outbound calls (browser-limited too — WhatsApp doesn't expose outbound calling to either unofficial connector) | Equivalent | Equivalent | No change |
| Channels (newsletters) | Real support: `newsletterCreate`/`newsletterFollow`/`newsletterFetchMessages`/`newsletterReactMessage`, `@newsletter` JID (`lib/Socket/newsletter.js`) — confirmed in the Phase 2 audit | `Channel` structure exists (`src/structures/Channel.js`) with `channelMetadata`, real subscribe/follow support | **Not built yet** in WhatchatAI (confirmed real gap, both connectors support the underlying capability) | Both support it | WhatchatAI's own Channels feature | Baileys already the chosen connector, so no reason to add whatsapp-web.js just for this | Both connectors are pull/fetch-based for channel messages, not live-pushed (Baileys: `newsletterFetchMessages`) | Build on Baileys — the capability genuinely exists there, no reason to add a second connector |
| Presence/receipts | Real `presence.update`, `messages.update` (delivery/read receipts) — already wired | Equivalent structures exist | Implemented, real | Yes | — | Equivalent | — | No change |
| LID (`@lid`) identity | Real, native support — `key.remoteJidAlt` is the authoritative lid→phone mapping source already used (`whatsapp_jid_mappings`) | No equivalent concept found in structures (whatsapp-web.js is older-architecture and predates widespread `@lid` rollout in its public API surface) | Implemented, real, honest (never fabricates a mapping) | Baileys: yes | whatsapp-web.js: not confirmed to expose this | Decisive point in Baileys' favor for 2025+ WhatsApp accounts, where `@lid` identities are now common | — | Confirms Baileys is the right choice independent of the resource-cost argument above |
| Outbound sending | `sock.sendMessage()` exists in the library; **not yet called anywhere in WhatchatAI** | `client.sendMessage()` equivalent | **Not built** — confirmed, real gap (see Phase 2 report) | Library-level: yes, both | WhatchatAI's own outbound dispatcher | N/A | N/A | Build on Baileys — this is an application-layer gap, not a connector-capability gap |

## Decisions

- **DO NOT replace Baileys.** The resource-cost gap (no-browser vs.
  full-Chromium-per-session) alone makes whatsapp-web.js unsuitable for a
  commercial multi-tenant SaaS running many concurrent WhatsApp accounts,
  and Baileys' native `@lid` support is a second, independent reason to
  keep it.
- **DO NOT run two connectors.** Nothing in this comparison surfaced a
  capability whatsapp-web.js has that Baileys categorically lacks for
  WhatchatAI's actual use case (only the album/commerce message types,
  which are proto-level, connector-independent gaps).
- **DO NOT duplicate authentication, QR, inbound, or outbound pipelines.**
  All confirmed to be Baileys-only in the current codebase; this
  comparison found no reason to change that.

See `docs/architecture/adr-001-whatsapp-connector.md` for the formal
decision record.
