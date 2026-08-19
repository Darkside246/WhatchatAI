# Architecture Gap Analysis

Synthesizes `whatsapp-connector-comparison.md`, `chatwoot-feature-map.md`,
and `whatsapp-feature-map.md` into a single implementation-ordered plan.
Two previously-undocumented real gaps were found while verifying this
document (not assumed — confirmed by grepping for actual usage) and are
called out below because they change the "already built" picture from
prior reports.

## CURRENT WHATCHATAI (verified this pass)

A mature, working WhatsApp-native foundation: 29 migrations covering
businesses, whatsapp_accounts, whatsapp_contacts, whatsapp_groups,
whatsapp_group_members, whatsapp_chats, whatsapp_messages,
whatsapp_message_reactions, whatsapp_media, whatsapp_presence,
whatsapp_calls, whatsapp_statuses, whatsapp_connection_events,
whatsapp_sync_jobs, whatsapp_jid_mappings, plans, plan_entitlements,
subscriptions, subscription_events, usage_counters, ai_agents,
crm_contacts, leads, security_lock_credentials, security_audit_logs. Real
Baileys ingestion, real encrypted-at-rest media pipeline, real WebSocket
real-time layer, real unread counters, real AI-screening Sentinel, real
onboarding/sync UI, a Phase 2 visual overhaul in progress. 146 passing
tests. Full details: `docs/database/schema.md`.

## Two newly-confirmed gaps (found while writing this document)

1. **`whatsapp_message_reactions` table and its repository
   (`WhatsAppMessageReactionRepository`) are dead code.** A repository-wide
   search confirms the repository class is never imported anywhere outside
   its own file. `reactionMessage` events are classified with
   `contentType: 'reaction'` in `whatsappMessageIngestionService.ts`, but
   `whatsappMessagePersistenceService.ts` has no special case for it — a
   reaction is persisted as an ordinary standalone row in `whatsapp_messages`
   (message_type `'reaction'`, `textContent` = the emoji), not linked to the
   message it reacted to. The schema for a proper reactions system exists
   and is unused.
2. **`whatsapp_presence` table and `WhatsAppPresenceRepository` are dead
   code** the same way — never imported outside their own file. No
   `presence.update` Baileys handler exists to populate it.

Both are real, additive fixes (wire an existing table to an existing
event), not new systems — flagged here rather than silently fixed, per the
directive's "explain current implementation → conflict → why it matters →
proposed change → risks → test required" rule.

| # | Current implementation | Conflict | Why it matters | Proposed change | Risks | Test required |
|---|---|---|---|---|---|---|
| 1 | Reactions persist as standalone messages | No reaction→target-message link exists in the data model, even though the table for it does | A chat UI can't show "👍 on this message" — it would show a phantom extra message instead | Add a `processReaction` case in `whatsappMessagePersistenceService`/worker that inserts into `whatsapp_message_reactions` (message_id, reactor JID, emoji) instead of `whatsapp_messages` | Low — additive, doesn't touch the existing message path for non-reaction content | New test: a `reactionMessage` event results in a `whatsapp_message_reactions` row and does NOT create a `whatsapp_messages` row |
| 2 | `whatsapp_presence` never populated | Schema promises presence tracking; nothing delivers it | Any future "online"/"typing" UI would show permanently empty state, or worse, be built against a table nobody writes to | Add a real `presence.update` handler in `whatsappConnectionService.ts` → `WhatsAppPresenceRepository.record()` | Low — additive, presence events are non-critical (append-only log per the repository's own doc comment) | New test: a real `presence.update` event results in a `whatsapp_presence` row |

Neither is fixed in this pass — per the directive's exact 12-step order,
this phase stops at restart/recovery tests, before touching live sync
behavior further. Both are recorded here as the next small, safe fixes.

## REFERENCE INSIGHTS (from actually reading Chatwoot + whatsapp-web.js source)

- **Chatwoot's `Inbox` channel polymorphism doesn't transfer.** It's built
  around official, webhook-pushed Business APIs (Chatwoot's own
  `Channel::Whatsapp` talks to Meta Cloud API/360dialog, not a QR-paired
  personal session) — a different problem than WhatchatAI's unofficial,
  Baileys-based connection. Not adopting it was the right call, now backed
  by source-level evidence instead of assumption.
- **Chatwoot's `AutomationRule` shape (event_name + conditions JSONB +
  actions JSONB + execution_delay) is a clean, reusable *concept*** for
  WhatchatAI's own future automation engine (phase 17) — genuinely worth
  designing an original version around, not copying.
- **Chatwoot's `Conversation` model shows what a real support-desk layer
  needs on top of a chat**: `status`, `priority`, `assignee_id`,
  `snoozed_until`, `waiting_since`/`first_reply_created_at` (for SLA/CSAT
  later), and — notably — tracking `contact_last_seen_at` *and*
  `agent_last_seen_at` separately, which is a more complete unread-state
  model than WhatchatAI's current single `unread_count` (real today, but
  one-directional).
- **whatsapp-web.js confirms Baileys' architectural advantage for this
  product**: a full Chromium-per-session model doesn't scale to "many
  WhatsApp accounts per SaaS deployment" the way a headless WebSocket
  session does. This is now a source-verified conclusion, not an assumed
  one.
- **whatsapp-web.js's `MessageTypes` enum surfaces two categories
  WhatchatAI doesn't classify**: explicit `ALBUM` grouping, and WhatsApp
  Business commerce types (`ORDER`/`PRODUCT`/`PAYMENT`). Both are
  proto/connector-level gaps, not implementation oversights — Baileys
  would need to expose the equivalent fields for WhatchatAI to persist
  them regardless of UI work.
- **Chatwoot's Captain (AI) is entirely `enterprise/`-licensed** — off
  limits for source reuse. Its *shape* (structured `guardrails`/
  `response_guidelines` config, an observation→suggestion feedback loop for
  improving AI answers over time) is a legitimate idea to design toward
  once WhatchatAI's own AI generation (phase 13) is built — currently the
  Sentinel only screens, it doesn't generate.

## MISSING SYSTEMS (confirmed, not fabricated)

Ranked by the directive's own phase order:
1. **Users/Memberships/Roles** — doesn't exist at all; blocks Teams/Permissions (phase 22) and everything support-desk-shaped in the Chatwoot feature map (agents, assignment, mentions, private notes).
2. **Outbound message dispatch** (text, then media) — confirmed missing in the Phase 2 report, still missing.
3. **AI reply generation** — Sentinel screens; nothing generates. Confirmed missing in the Phase 2 report, still missing.
4. **Reactions and presence wiring** — schema/repos exist, event handlers don't (newly confirmed above).
5. **Channels** — real Baileys support confirmed twice now (Phase 2 audit + this pass); not built.
6. **CRM depth** (notes, custom attributes, labels beyond tags, canned responses) — `crm_contacts`/`leads` exist; the rest doesn't.
7. **Automation/Knowledge/Campaigns/Analytics/Billing UI** — schema-level placeholders only, correctly deferred per the directive's own "don't fully implement unless required for the database foundation" instruction.

## CONFLICTS

None found between the reference projects' architecture and WhatchatAI's
existing foundation. The one thing that could look like a conflict —
Chatwoot's inbox/channel polymorphism vs. WhatchatAI's WhatsApp-account-
as-inbox model — isn't actually a conflict once the underlying difference
(official Business API vs. unofficial personal-session connector) is
understood; adopting Chatwoot's abstraction would solve a problem
WhatchatAI doesn't have.

## RECOMMENDED ARCHITECTURE

Keep the current WhatsApp-account-centric model
(`business_id → whatsapp_account_id → contact/chat/message`) as the
foundation — it's real, tested, and correctly scoped for a WhatsApp-first
product, not a generic-omnichannel one like Chatwoot. Layer the missing
systems on top without restructuring what exists:

- Users/Memberships/Roles as a new, independent domain (foreign keys to
  `business_id` only — doesn't touch the WhatsApp tables).
- Outbound dispatch and AI generation as new services consuming the
  existing `whatsappConnectionService`'s live socket and the existing
  `ai_agents`/Sentinel infrastructure, respectively.
- Reactions/presence: wire the two dead-code repositories to real
  handlers (smallest possible fix, see table above).
- Channels: new `whatsapp_channels`/`whatsapp_channel_messages` tables
  following the exact same tenant-scoping and media-reuse pattern as
  everything else — not a parallel system.

## IMPLEMENTATION ORDER

Matches the directive's phase numbering, adjusted for what's already done:
1. ~~Phases 1-11 (database foundation, WhatsApp ingestion, sync)~~ — **substantially complete**, restart/recovery-tested (see FINAL REPORT below for this pass's fresh test run).
2. Small fixes: wire reactions + presence (both confirmed dead code above).
3. Outbound text dispatch (prerequisite for outbound media, phase 12).
4. AI reply generation (phase 13) — the Sentinel already screens; this adds the actual Gemini call.
5. Users/Memberships/Roles (part of phase 22, pulled earlier since Teams/Assignment/Notes/Mentions all depend on it).
6. Channels (phase 11 extension, real Baileys support confirmed).
7. Remaining CRM/Automation/Knowledge/Analytics/Marketing/Billing depth, in the directive's original phase order.
