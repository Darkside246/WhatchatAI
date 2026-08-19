# WhatsApp Feature Map — Connector Support vs. Actual WhatchatAI Implementation

Companion to `whatsapp-connector-comparison.md` (which compares the
*connectors*); this tracks, feature by feature, whether Baileys/
whatsapp-web.js expose the capability at all, and — separately, since
connector support doesn't mean WhatchatAI uses it — whether WhatchatAI
actually implements it today. Source: direct inspection of the installed
`@whiskeysockets/baileys@7.0.0-rc14` and a fresh clone of
`whatsapp-web.js`, cross-referenced against WhatchatAI's own source.

| Feature | Baileys 7.0.0-rc14 | whatsapp-web.js | WhatchatAI Implements | Notes |
|---|---|---|---|---|
| QR pairing | Yes | Yes | **Yes** | `whatsappConnectionService.ts`, real QR polling to the frontend |
| Multi-device session persistence | Yes (`useMultiFileAuthState` or custom store) | Yes (`LocalAuth`/`RemoteAuth` strategies) | **Yes** | File-based auth state |
| Contacts sync | Yes | Yes | **Yes** | `whatsapp_contacts`, real reconciliation on later-arriving metadata |
| Chats sync | Yes | Yes | **Yes** | `whatsapp_chats` |
| Groups + members | Yes | Yes | **Yes** | `whatsapp_groups`/`whatsapp_group_members` |
| Message history backfill | Yes (`messages.upsert` with `type: 'append'`, history-sync events) | Yes (own history-load mechanism) | **Yes** | `is_historical` flag, real (see Historical Message Rule below) |
| Text messages (in) | Yes | Yes | **Yes** | Full pipeline, encrypted at rest |
| Text messages (out) | Yes (`sock.sendMessage`) | Yes (`client.sendMessage`) | **No** | Confirmed real gap — no outbound dispatcher built yet |
| Image/video/audio/document/sticker media (in) | Yes (`downloadMediaMessage`) | Yes | **Yes** | Full real pipeline: download, SHA-256 checksum, AES-256-GCM at rest, authenticated Range-capable serving |
| Media (out) | Yes | Yes | **No** | Depends on outbound text dispatch existing first |
| Voice notes | Yes (`ptt` flag on audioMessage) | Yes (`MessageTypes.VOICE` = `'ptt'`) | Inbound: **Yes**. Outbound recording: **No** | `MediaRecorder`-based recording not built |
| Stickers | Yes | Yes | **Yes** (inbound) | |
| Albums (multi-image grouping) | Not a distinct Baileys proto concept exposed at the app layer used here | Explicit `ALBUM` type in `MessageTypes` | **No** | Confirmed deferred gap; each image in an album persists individually and correctly today, just ungrouped |
| View-once media | Yes (`viewOnceMessage`/`viewOnceMessageV2`/`viewOnceMessageV2Extension`) | Partial | **Deliberately not downloaded** | Classified for caption/preview only; binary is never fetched, matching WhatsApp's own privacy model — a deliberate design choice, not a gap |
| Reactions | Yes (`reactionMessage`) | Yes (`Reaction` structure) | **Yes** | `whatsapp_message_reactions` table |
| Polls | Yes (`pollCreationMessage`, V2/V3, `pollUpdateMessage`) | Yes (`Poll`/`PollVote`) | Classification: **Yes**. Vote tallying: **Not confirmed built** | `poll`/`poll_response` content types exist |
| Location | Yes | Yes (`Location` structure) | Classification only: **Yes**, coordinates not persisted to a dedicated field | |
| Contact cards | Yes (`contactMessage`/`contactsArrayMessage`) | Yes (`vcard`/`multi_vcard`) | Classification: **Yes** | Not parsed into structured contact-import data |
| Group invites | Yes | Yes | Classification: **Yes** | |
| Buttons/lists/interactive/templates | Yes (`buttonsMessage`, `listMessage`, `interactiveMessage`, `templateMessage`, and their `*ResponseMessage` counterparts) | Yes (`Buttons`, `List`) | Classification: **Yes** | |
| Edited messages | Yes (`editedMessage` wrapping `IFutureProofMessage`) | Not confirmed as a distinct structure | **Yes** | Unwrapped to real underlying content |
| Delivery/read receipts | Yes (`messages.update`) | Yes | **Yes** | Real status tracking, drives the delivery-tick UI |
| Presence (typing/online) | Yes (`presence.update`) | Yes | **No** | `whatsapp_presence` table and `WhatsAppPresenceRepository` both exist, but a repository-wide search confirms the repository is never imported anywhere else in `src/` — no live `presence.update` handler calls it. Real, confirmed, previously-undocumented gap: schema and repository built, never wired to a Baileys event |
| Status/Stories (text) | Yes (`status@broadcast` JID convention) | Not clearly exposed in the public structures list inspected | **Yes** | Real routing to `whatsapp_statuses`, confirmed working |
| Status/Stories (media) | Same download path as regular media would apply | — | **No** | `whatsapp_statuses.media_id` always NULL — confirmed real, unchanged gap |
| Calls (events) | Yes (`call` event: offer/ringing/accept/reject/timeout/terminate) | Yes (`Call` structure) | **Yes** | Real state machine with documented 60s ring-timeout reconciliation |
| Calls (placing outbound) | No — WhatsApp doesn't expose this to unofficial connectors | No | **No** | Not a WhatchatAI gap — a genuine WhatsApp platform restriction on both unofficial connectors |
| `@lid` identity | Yes, native (`key.remoteJidAlt`) | Not confirmed present in the inspected structures (older architecture) | **Yes** | `whatsapp_jid_mappings`, honest (never fabricates a mapping) |
| Channels (newsletters) | Yes (`newsletterCreate`/`Follow`/`FetchMessages`/`ReactMessage`, `@newsletter` JID) | Yes (`Channel` structure) | **No** | Confirmed real, buildable gap — not attempted yet |
| Business profile (catalog/products) | Not exposed in the app's current usage | Yes (`Product`/`Order`/`Payment`/`ProductMetadata` structures) | **No** | Out of scope for WhatchatAI's current direction |

## Historical Message Rule — confirmed correctly implemented

`is_historical` is real and enforced: `whatsappMessageIngestionService.ts`
sets `isLive: upsertType === 'notify'` (Baileys only reports `'notify'` for
genuinely live traffic), and the persistence/worker layer only triggers
the AI-handoff path when `message.isLive` is true — confirmed in
`src/queue/workers/incomingMessagesWorker.ts`'s `needsAiHandoff` check.
Historical backfill can never trigger a live AI response.
