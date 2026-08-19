# Chatwoot ↔ WhatchatAI Capability Gap Matrix

**Methodology.** Every "Chatwoot capability" cell below is sourced from a
fresh, direct inspection of Chatwoot's real source
(`GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/chatwoot/chatwoot`,
commit `e52a731b`, 2026-08-17) — real files under `app/models/` and
`enterprise/app/models/`, cited by path, with real schema columns read from
each model's annotated header comment. Every "WhatchatAI capability" cell is
sourced from this repository's real migrations (`src/db/migrations/`), real
API routes (`src/server/index.ts`), and real frontend pages
(`src/web/src/pages/`) as they exist today — not from memory of an earlier
session, and not from what was *planned*.

**Licensing (read before using any row below).** Chatwoot's `enterprise/`
tree is governed by `enterprise/LICENSE`, which forbids using, copying,
modifying, or distributing that code in production without a paid Chatwoot
Enterprise subscription (development/testing use is explicitly permitted,
production reuse is not). As of this audit, **Companies, SLA policies,
Agent Capacity Policies, Custom Roles, Calling, and Copilot (agent-facing AI
drafting) all live under `enterprise/`** — a change from the last audit
pass, where Companies in particular was assumed to be core. Every row below
marks its Chatwoot source as **(core/MIT)** or **(enterprise)**. For
enterprise-sourced rows, only the *conceptual shape* (which real columns
and relationships the feature needs) is used to design an original
WhatchatAI implementation — no code, schema DDL, or file content from
`enterprise/` has been or may be copied.

**Column legend.** GAP is phrased as what's missing, not what exists. STATUS
uses the seven values the directive specifies: `FULLY PRESENT`,
`PARTIALLY PRESENT`, `MISSING`, `NOT APPLICABLE`,
`UNSUPPORTED BY CURRENT WHATSAPP CONNECTOR`, `PLANNED`, `DEFERRED`.

---

## 1. Inbox

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Inbox as channel container | `Inbox` (core/MIT, `app/models/inbox.rb`): polymorphic `channel_type`/`channel_id` across Email/API/Website/WhatsApp/etc, `working_hours_enabled`, `auto_assignment_config` jsonb, `csat_config` jsonb, `enable_auto_assignment` | `whatsapp_accounts` IS the inbox, 1:1 with a real Baileys connection — no polymorphic channel type exists or is needed while WhatsApp-only | `whatsapp_accounts` table (migration 002), one row per connected WhatsApp number | No multi-channel-type polymorphism — deliberate, not an oversight | N/A now | N/A now | N/A now | N/A now | Yes | No | N/A | N/A | — | NOT APPLICABLE |
| Per-inbox working hours / auto-responder config | `Inbox#working_hours_enabled`, `#out_of_office_message`, `#greeting_enabled`/`#greeting_message` | None | Not built | No business-hours or auto-responder config anywhere | Extend `whatsapp_accounts` or new `business_hours` table | Yes | Yes | Yes | No | Maybe (AI can use hours for auto-responder tone) | Plan-gated (higher tiers only) | Low | Phase A (Support Desk Core) | MISSING |
| Multi-inbox routing per business | `enable_auto_assignment`, per-inbox capacity | Single WhatsApp account per business today (multi-account architecture researched, not built) | One `whatsapp_accounts` row expected per business in practice | Multi-account UI/routing | Already schema-ready (`whatsapp_accounts.business_id` is already 1:many) | Minor | Minor | Yes | Yes | No | Plan-gated (multi-number is a real upsell) | Medium (per-account isolation) | Phase A | PARTIALLY PRESENT |

## 2. Conversations

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Conversation record | `Conversation` (core/MIT, `app/models/conversation.rb`): `status` enum (open/resolved/pending/snoozed), `priority`, `snoozed_until`, `waiting_since`, `first_reply_created_at`, `contact_last_seen_at`/`agent_last_seen_at`, `uuid`+`display_id` | `whatsapp_chats` (migration 006) is the real, live WhatsApp thread: `unread_count`, `last_message_at`, `ai_mode` (AI_ACTIVE/AI_PAUSED/HUMAN_TAKEOVER) | Fully real, fully working — this is the app's core data path | No `status`(open/pending/resolved)/`priority`/`snoozed_until` — support-desk workflow state layered on top of the WhatsApp thread | New nullable columns on `whatsapp_chats` (never a second "conversation" table — see Data Model section in the closure audit) | Yes | Yes | Yes | No | No | Free tier gets basic status; priority/SLA plan-gated | Tenant isolation (already enforced on `whatsapp_chats`) | Phase A | PARTIALLY PRESENT |
| Snooze / resolve / reopen | `Conversation#status`, `#snoozed_until`, timeline events | None | Not built | No snooze/resolve state machine | `whatsapp_chats.status`, `snoozed_until` | Yes | Yes | Yes | No | No | Included in all tiers | None extra | Phase A | MISSING |
| Conversation participants (multiple humans watching one thread) | `ConversationParticipant` (core/MIT) | None (no users yet — see §6 Teams/Agents) | Not built | Depends entirely on §6 | `conversation_participants` table | Yes | Yes | Yes | No | No | Team-seat gated | Tenant isolation | Phase B (after Teams/Users) | MISSING |
| Conversation ↔ WhatsApp message duplication | N/A (Chatwoot's `Message` model *is* its message store) | `whatsapp_messages` already stores the real, encrypted message history | Fully real | None — this is a deliberate design win, see closure audit's Data Model section | — | — | — | — | Yes | No | — | AES-256-GCM at rest (already implemented) | — | BETTER IN WHATCHATAI |

## 3. Contacts

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Contact identity | `Contact` (core/MIT, `app/models/contact.rb`): `name`/`email`/`phone_number`/`identifier`, `additional_attributes`/`custom_attributes` jsonb, `blocked`, `last_activity_at` | `whatsapp_contacts` (migration 003): real WhatsApp identity reconciliation (verified_name/business_name/push_name/short_name, `@lid`↔phone mapping, real profile photo sync) | Fully real and, on WhatsApp-native fields, materially richer than Chatwoot's generic contact | No `blocked` flag; no free-form `additional_attributes` on `whatsapp_contacts` itself (customer-facing custom fields live one layer up, on `crm_contacts.custom_fields` — see below) | `blocked` column | Yes | Yes | Yes | No | No | Included | None extra | Phase A | PARTIALLY PRESENT |
| CRM-layer customer profile | Chatwoot has no separate CRM layer — `Contact#custom_attributes` is the whole story | `crm_contacts` (migration 023): `stage`, `lead_status`, `tags` jsonb, `notes`, `ai_summary`, `customer_value`, `follow_up_date`, **`custom_fields` jsonb** | Fully real, already exposed via `GET/PATCH /api/workspace/crm-contacts` and the CRM page | `custom_fields` is free-form jsonb with no admin-defined schema (typed field *definitions* are §12) | — | — | — | — | No | Yes (`ai_summary`) | Plan-gated fields possible | Tenant isolation (already enforced) | — | BETTER IN WHATCHATAI |
| Contact history (all touches: conversations, campaigns, automation) | Assembled dynamically from `Conversation`/`Campaign`/`AutomationRule` associations | Message/call/status history all real and queryable per contact; campaign/automation history doesn't exist yet (those features don't exist yet, §21/§19) | Partial — conversation history real, campaign/automation history N/A until those exist | Campaign & automation history views | Depends on §19/§21 | Depends | Depends | Yes | No | No | Included | Tenant isolation | Phase C | PARTIALLY PRESENT |
| Blocked / do-not-contact | `Contact#blocked` | None | Not built | No block flag, no enforcement in outbound send path | `whatsapp_contacts.blocked` or `crm_contacts` equivalent | Yes | Yes | Yes | Yes (must gate outbound send + AI auto-reply) | No | Included | Must be enforced at send-time, not just UI-hidden | Phase A | MISSING |

## 4. Companies

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Company / organization record | `Company` (**enterprise**, `enterprise/app/models/company.rb`): `name`, `domain`, `description`, `additional_attributes`/`custom_attributes` jsonb, `contacts_count`, `last_activity_at`; unique `(account_id, domain)` | None | Not built | Entire feature missing | New `companies` table | Yes | Yes | Yes | No | Maybe (AI can group B2B threads by company) | **Higher-tier plan gate recommended** — Chatwoot itself gates this behind Enterprise | Tenant isolation | Phase C (B2B CRM) | MISSING |
| Contact ↔ company relationship | `belongs_to :company` on `Contact` (enterprise) | None | Not built | No linkage | `crm_contacts.company_id` FK, nullable (never forced — directive explicitly says don't force consumer users into a company structure) | Yes | Yes | Yes | No | No | Same tier as Companies | Tenant isolation | Phase C | MISSING |

## 5. Teams

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Team grouping | `Team` (core/MIT, `app/models/team.rb`): `name`, `description`, `icon`, `allow_auto_assign`; `TeamMember` join table | None — **no `teams` table exists** | Not built | Entire feature blocked on §6 (Agents/Users) existing first | `teams`, `team_members` tables | Yes | Yes | Yes | No | No | Team-seat gated | Tenant isolation | Phase B | MISSING |

## 6. Agents / Users / Roles

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| User accounts | `User` (core/MIT) + `AccountUser` (core/MIT, `app/models/account_user.rb`): `role` enum (agent/administrator), `availability` enum, per-account membership | None. Confirmed via migration inspection: **no `users`, `account_users`, `sessions`, or `roles` table exists anywhere in `src/db/migrations/`.** The app runs as an implicit single-business context (`BusinessRepository.ensureDefault()`) | Missing entirely — this remains the single largest confirmed gap in the whole audit, unchanged since the last pass | Full multi-user auth: users, sessions, per-business membership, password/passkey handling, invite flow | `users`, `business_users` (or `account_users`), `sessions` tables | Full auth system (login, session, invite, password reset) | Full auth API | Full auth UI (login, invite, member management) | No | No | Seat-based billing depends entirely on this existing | Password hashing, session security, CSRF, rate limiting on auth endpoints | Phase B (foundational — blocks §5, §7, §8, §9, §10 below) | MISSING |
| Custom roles / granular permissions | `CustomRole` (**enterprise**, `enterprise/app/models/custom_role.rb`): `permissions` text array — e.g. `conversation_manage`, `conversation_unassigned_manage`, `conversation_participating_manage`, `contact_manage`, `report_manage` | None | Not built | Depends on §6 users existing | `custom_roles` table + join | Yes | Yes | Yes | No | No | **Higher-tier gate** (mirrors Chatwoot's own enterprise gating) | Authorization must be enforced server-side on every route, not just hidden in UI | Phase B+ | MISSING |
| Screen-lock PIN (WhatchatAI's own, not a Chatwoot concept) | N/A | `security_lock_credentials` (migration 027): Argon2id-hashed PIN, real lockout after failed attempts; `security_audit_logs` (028) for real audit trail; live `ScreenLock.tsx` overlay that never pauses background AI/messaging | Fully real and already shipped | None | — | — | — | — | No | No | Included | Argon2id, revocation on repeated failure | — | BETTER IN WHATCHATAI (fills a real single-operator security need Chatwoot doesn't have, ahead of full multi-user auth) |

## 7. Assignment

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Conversation assignment | `Conversation#assignee_id`/`#assignee_agent_bot_id`/`#team_id`, `AssignmentHandler` concern | `whatsapp_chats.ai_mode` (AI_ACTIVE / AI_PAUSED / HUMAN_TAKEOVER) is a real, working, narrower analog for "who's handling this right now" | Partial — the AI-vs-human axis is real and live; assignment to a *specific* human/team doesn't exist (blocked on §6) | Per-conversation `assignee_user_id`/`assignee_team_id` | `whatsapp_chats.assignee_user_id`/`assignee_team_id` | Yes | Yes | Yes | No | No | Included once §6 exists | Tenant isolation | Phase B | PARTIALLY PRESENT |
| Assignment policy engine | `AssignmentPolicy` (core/MIT, `app/models/assignment_policy.rb`): `assignment_order` (round_robin), `conversation_priority`, `fair_distribution_limit`/`_window`, `exclude_older_than_hours` | None | Not built | Full routing-rules engine | `assignment_policies` table | Yes | Yes | Yes | No | Maybe (AI-assisted routing) | Higher-tier plan gate | Tenant isolation | Phase C | MISSING |
| AI-to-agent handoff routing | Not a native Chatwoot concept (agent bots are external webhooks) | `ai_mode` HUMAN_TAKEOVER state already exists as the toggle point | Real, but only a binary switch, not a reasoned handoff decision (see §28 AI Handoff) | Structured handoff reason/trigger | See §28 | See §28 | See §28 | See §28 | No | Yes | Included | Tenant isolation | Phase C | PARTIALLY PRESENT |

## 8. Agent Capacity

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Per-agent max active conversations | `AgentCapacityPolicy` (**enterprise**): `exclusion_rules` jsonb, `InboxCapacityLimit` join for per-inbox caps | None | Not built | Entire feature blocked on §6 | `agent_capacity_policies`, `inbox_capacity_limits` | Yes | Yes | Yes | No | No | **Higher-tier gate** (mirrors Chatwoot's enterprise gating) | Tenant isolation | Phase C | MISSING |

## 9. Private Notes

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Internal notes on a conversation | `Note` (core/MIT, `app/models/note.rb`): `content`, `account_id`, `contact_id`, `user_id` | `crm_contacts.notes` is a single free-text field, not a real threaded/timestamped note log | Partial — a notes *field* exists, a notes *log* does not | Real `notes` table: multiple, timestamped, authored, never sendable to WhatsApp | `conversation_notes` table (`whatsapp_chat_id`, `author_user_id`, `content`, timestamps) | Yes | Yes | Yes | **Must be architecturally guaranteed to never enter the outbound-send path** — a hard invariant, not a UI convention | No | Included | The send-path itself must reject any payload sourced from the notes table | Phase B (needs §6 for `author_user_id`) | PARTIALLY PRESENT |

## 10. Mentions

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `@user` in notes | `Mention` (core/MIT, `app/models/mention.rb`): unique per `(conversation_id, user_id)` | None | Not built | Depends entirely on §6 + §9 | `mentions` table | Yes | Yes | Yes | No | No | Included | Tenant isolation | Phase B | MISSING |

## 11. Labels

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Reusable, colored labels | `Label` (core/MIT, `app/models/label.rb`): `title`, `color`, `description`, `show_on_sidebar`, unique per account; `Conversation#cached_label_list` | `crm_contacts.tags` jsonb is real, persisted, contact-scoped tagging (already rendered in the CRM UI) | Partial — contact-level tags real; no admin-defined label *catalog* (color/description), no conversation-level labels | `labels` table (title/color/description) + `conversation_labels`/`contact_labels` join, replacing the free-form jsonb tag array with a real catalog | `labels`, `conversation_labels` tables | Yes | Yes | Yes | No | No | Included | Tenant isolation | Phase A | PARTIALLY PRESENT |

## 12. Custom Attributes

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Admin-defined typed fields | `CustomAttributeDefinition` (core/MIT): typed (text/number/boolean/date/select/multi-select), scoped to contact/conversation/company | `crm_contacts.custom_fields` jsonb exists and is real, but has **no admin-defined schema** — any key/value can be stored, untyped, unvalidated | Partial — storage exists, definition/typing layer doesn't | `custom_attribute_definitions` table (key, label, data_type, options for select, applies_to) + validation against it on write | Yes | Yes | Yes | No | No | Included | Tenant isolation | Phase A | PARTIALLY PRESENT |

## 13. Canned Responses & Macros

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Canned response (reusable text) | `CannedResponse` (core/MIT, `app/models/canned_response.rb`): `short_code`, `content`, per-account, unique short_code, searchable | None | Not built | Directive explicitly wants `/pricing`-style shortcuts | `canned_responses` table | Yes | Yes | Yes | No | Maybe (AI-suggested canned response) | Included | Tenant isolation | Phase A | MISSING |
| Macro (multi-action) | `Macro` (core/MIT, `app/models/macro.rb`): `actions` jsonb (ordered action list), `visibility` (personal/global) | None | Not built | Real action-executor: assign team, add label, send canned response, create task, all in one click | `macros` table + an action-executor service that actually performs each action type | Yes | Yes | Yes | No | No | Included | Every action must actually execute, never a fake "done" toast | Phase B (depends on labels/assignment) | MISSING |

## 14. Custom Views & Filters

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Saved filter views | `CustomFilter` (core/MIT, `app/models/custom_filter.rb`): `filter_type` enum (conversation/contact/report), `query` jsonb, per-user | The chat list has hardcoded filter pills (All/Unread/Groups) — real but not user-definable | Partial — filtering exists, it isn't extensible or saveable | `custom_filters` table + a real filter-query interpreter reused across chat list, CRM, and reports | Yes | Yes | Yes | No | No | Higher-tier gate (advanced filters) | Tenant isolation | Phase B | PARTIALLY PRESENT |
| Reusable filter engine (operates on real fields) | Chatwoot's filter query language spans conversations/contacts/reports uniformly | None generalized — CRM list filtering is separate ad-hoc query params | Ad-hoc, not reusable | A single filter-condition evaluator (field/operator/value) usable by views, automation conditions, and reports alike | Shared filter-spec type | Yes | Yes | Yes | No | No | Higher-tier | Tenant isolation, injection-safe query building | Phase B | MISSING |

## 15. Business Hours

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Per-day open/close config | `WorkingHour` (core/MIT, `app/models/working_hour.rb`): `day_of_week`, `open_hour`/`open_minutes`, `close_hour`/`close_minutes`, `open_all_day`, `closed_all_day`, per-inbox; `Inbox#timezone` | None | Not built | Real per-account (or per-inbox once multi-account exists) hours table | `working_hours` table | Yes | Yes | Yes | No | Yes (auto-responder/AI tone can read hours) | Plan-gated | Tenant isolation | Phase A | MISSING |
| Holiday / special-hours override | Not a distinct Chatwoot model (handled via `closed_all_day` per date in some deployments) | None | Not built | Date-specific overrides | Extend `working_hours` or add `business_hour_exceptions` | Yes | Yes | Yes | No | No | Plan-gated | Tenant isolation | Phase A | MISSING |

## 16. Auto Responders

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Out-of-office auto-reply | `Inbox#out_of_office_message`, `#greeting_message`/`#greeting_enabled` | None as a *configured* message; AI reply generation is real and always-on (§28's `aiReplyService.ts`, `thinkingBudget:0`+`maxOutputTokens` hardened this session) but has no "outside business hours" branch | Missing the specific "closed" behavior; the general AI-reply engine it would plug into is real | A business-hours-aware branch in `aiReplyService`: continue normally / collect info / request human follow-up, per config | Depends on §15 | Yes (extend `aiReplyService.ts`) | Minor | Yes (config UI) | No | Yes | Included | None extra | Phase A (after §15) | PARTIALLY PRESENT |

## 17. Automations & Conversation Workflows

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Event → condition → action rules | `AutomationRule` (core/MIT, `app/models/automation_rule.rb`): `event_name`, `conditions` jsonb, `actions` jsonb, `execution_delay` (10 min–30 days), `active` | `ai_mode` is a narrow, real automation primitive (routes inbound messages to Gemini when AI_ACTIVE); no general trigger→condition→action engine exists | Partial — one hardcoded "automation" (AI routing) is real; a general rules engine isn't | `automation_rules` table + a real executor reusing the §14 filter-condition evaluator + the §13 macro action-executor | Yes | Yes | Yes | No | Yes (some triggers are AI-classified: sentiment, intent) | Higher-tier gate | Tenant isolation, execution audit log | Phase C | PARTIALLY PRESENT |
| Multi-step customer-journey workflow | Not a native single Chatwoot model — composed from automation rules + macros + labels + CRM stage changes | `leads.status` (NEW/QUALIFIED/ENGAGED/WON/LOST) is a real, working pipeline stage machine, but each transition is manual today, not workflow-driven | Real pipeline state; no workflow orchestration on top | A `conversation_workflows`/`workflow_instances` layer that advances lead stage, creates tasks, and notifies humans as steps complete | `workflow_definitions`, `workflow_instances` tables | Yes | Yes | Yes | No | Yes | Higher-tier gate | Tenant isolation | Phase C | PARTIALLY PRESENT |

## 18. Campaigns

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Outbound campaign send | `Campaign` (core/MIT, `app/models/campaign.rb`): `campaign_type` (one-off/ongoing), `audience` jsonb, `trigger_rules` jsonb, `scheduled_at`, `trigger_only_during_business_hours` | None | Not built | **Real WhatsApp constraint, not just a missing feature**: Baileys sends via the same personal-account protocol as manual messages — there is no WhatsApp Business Platform (Cloud API) template-message integration in this app. Bulk unsolicited outbound over a personal WhatsApp Web session risks the connected number being banned by WhatsApp itself. Any campaign feature MUST be built as opt-in, rate-limited, and scoped to contacts with a real prior inbound conversation (never cold outreach), with honest per-recipient status tracked from real `messages.upsert`/`messages.update` events (queued/sent/delivered/read/failed) — reusing the exact same `whatsapp_outbound_messages` pipeline already built for 1:1 sends | `campaigns`, `campaign_recipients` tables | Yes — reuse `whatsappOutboundMessageService`/BullMQ queue, add real per-recipient throttling | Yes | Yes | Yes (every send is a real Baileys `sendMessage`) | No | Plan-gated, hard cap on recipients per plan tier | Rate limiting is a product-survival requirement here, not optional | Phase D | MISSING |
| Campaign delivery tracking | `CampaignEvent`-equivalent via existing conversation delivery status | None | Not built | Reuse the real `whatsapp_outbound_messages.status` state machine already built and tested this session | Reuse existing table + `campaign_id` FK | Yes | Yes | Yes | Yes | No | Included with campaigns | Same as above | Phase D | MISSING |

## 19. Segments

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Contact segments | Derived dynamically from `CustomFilter`s of `filter_type: contact` | None | Not built | Depends entirely on §14's filter engine existing first | Reuses `custom_filters` | Yes | Yes | Yes | No | No | Higher-tier gate | Tenant isolation | Phase C | MISSING |

## 20. Live View

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Real-time operational dashboard | ActionCable-backed live agent dashboard | WhatchatAI already has a real, working WebSocket + Redis pub/sub transport (`src/server/index.ts`'s `/ws` bridge, `useWhatsAppSync` hook) pushing `message.new`/`chat.updated`/`message.reaction`/`presence.updated` events live | Transport is real and proven; no operational dashboard *view* built on top of it | A Live View page: active conversations, AI-vs-human split, new leads, escalations — all sourced from real WebSocket events, zero polling-only simulated activity | None new (reuses existing tables) | Minor (may need a couple of aggregate queries) | Minor | Yes | No | No | Included (dashboard tier) | Tenant isolation | Phase C | PARTIALLY PRESENT |

## 21. Reports

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Rollup reporting events | `ReportingEvent`/`ReportingEventsRollup` (core/MIT): `name`, `value`, `value_in_business_hours`, scoped to account/conversation/inbox/user | `getDashboardOverview()` (real, `workspaceService.ts`) computes real aggregate counts (messages/chats/calls/outbound replies) directly from source tables on each request — no separate rollup/event-log table | Dashboard numbers are 100% real, computed live; no historical *event log* for trend analysis over time, no per-agent/per-team/per-label breakdown (those axes don't exist yet — §6/§11) | `reporting_events` table + a real event-emission point at each state change (message sent, conversation resolved, CSAT received) | Yes | Yes | Yes | Yes | No | No | Plan-gated by report depth | Tenant isolation | Phase C | PARTIALLY PRESENT |
| Agent / team / label / campaign reports | Filtered views over `ReportingEvent` | None (blocked on §6/§11/§18 existing) | Not built | Depends on those features first | — | — | — | — | — | — | Plan-gated | — | Phase D | MISSING |
| Downloadable/exportable reports | CSV export endpoints | None | Not built | Real CSV/export generation from the same source tables reports read from — never a separately maintained export dataset | None new | Yes | Yes | Yes | No | No | Plan-gated | Tenant isolation on export scope | Phase D | MISSING |

## 22. CSAT

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Post-conversation rating | `CsatSurveyResponse` (core/MIT): `rating`, `feedback_message`, `csat_review_notes`, linked to `contact_id`/`conversation_id`/`message_id`/`assigned_agent_id` | None | Not built | A real post-resolution rating prompt sent as an actual WhatsApp message (interactive buttons or numbered reply), with a real response-capture path back into a `csat_responses` table | `csat_responses` table | Yes (trigger on conversation resolve + a real inbound-reply capture path) | Yes | Yes | Yes (the rating request is itself a real outbound WhatsApp message) | No | Plan-gated | Tenant isolation | Phase C | MISSING |

## 23. SLA / Response Management

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SLA policy definition | `SlaPolicy` (**enterprise**): `first_response_time_threshold`, `next_response_time_threshold`, `resolution_time_threshold`, `only_during_business_hours` | None | Not built | Entire feature blocked on §15 (business hours) for the `only_during_business_hours` variant to be meaningful | `sla_policies` table | Yes | Yes | Yes | No | No | **Top-tier plan gate** (mirrors Chatwoot's own enterprise gating) | Tenant isolation | Phase D | MISSING |
| SLA breach tracking/events | `AppliedSla`/`SlaEvent` (**enterprise**) | None | Not built | Real timestamp-driven breach detection (a scheduled sweep comparing `first_reply_created_at`/`waiting_since` against policy thresholds), never a simulated "at risk" flag | `applied_slas`, `sla_events` tables | Yes (real scheduled job, same pattern as the existing call-timeout/sync-job-timeout sweeps) | Yes | Yes | No | Top-tier | Tenant isolation | Phase D | MISSING |

## 24. Help Center

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Public knowledge base | `Portal`/`Category`/`Folder`/`Article`/`RelatedCategory` (core/MIT): draft/publish workflow, SEO metadata, search | None | Not built | Full article CMS: portal config, categories, articles with draft/publish states, search index | `portals`, `categories`, `articles` tables | Yes | Yes | Yes | No | Yes (this becomes a real AI knowledge source — see §26) | Plan-gated | Tenant isolation; public portal must not leak other tenants' articles | Phase D | MISSING |

## 25. Captain-style AI Assistance (agent-facing)

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Draft/suggest/improve-tone reply for a human agent | `Captain::Assistant` (**enterprise**): `config`/`guardrails`/`response_guidelines` jsonb; `Copilot::Thread`/`Copilot::Message` (**enterprise**, separate agent-facing chat-with-your-data feature) | WhatchatAI's `aiReplyService.ts` (real, Gemini-backed, `thinkingBudget:0` hardened this session) generates the *entire customer-facing reply autonomously* when AI_ACTIVE — a fundamentally different mode from Chatwoot's Copilot (which drafts *for a human to review*, never sends on its own) | Partial — autonomous generation is real and live; a human-review-before-send "suggest" mode doesn't exist | A `HUMAN_TAKEOVER`-mode variant: same `aiReplyService` engine, output shown as a draft in the composer instead of auto-sent, plus summarize/translate/fix-grammar/change-tone as standalone one-shot Gemini calls | None new (reuses `ai_agents`) | Yes (new service methods, same Gemini client already extracted) | Yes | Yes (composer "suggest" button) | No | Yes | Included/plan-gated by call volume | Tenant isolation | Phase C | PARTIALLY PRESENT |
| Summarize conversation | `Captain`/`Copilot` conversation summary (**enterprise**) | None as a UI action (the `ai_summary` column on `crm_contacts` exists in schema but nothing writes to it yet) | Column exists, unpopulated | A real one-shot Gemini summarization call, writing to the existing `ai_summary` column | — (column exists) | Yes | Yes | Yes | No | Yes | Included | Tenant isolation | Phase C | PARTIALLY PRESENT |
| Answer from knowledge base | `Captain::FaqObservation`/`FaqSuggestion`/`Document` (**enterprise**) — observation→suggestion feedback loop | None (§24 Help Center doesn't exist yet to answer from) | Not built | Depends on §24 + §26 | See §26 | See §26 | See §26 | See §26 | No | Yes | Included | Tenant isolation | Phase D | MISSING |

## 26. AI + Knowledge Sources

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Multi-source retrieval with provenance | `Captain::Document`/`ArticleEmbedding` (**enterprise**) — vector-embedded document store | `aiContextGathererService.ts` is real and already assembles CRM record + conversation history + knowledge-base placeholder in parallel (`Promise.all`) — the knowledge-base branch is a real, honestly-labeled "not yet available" stub, not fake results | Partial — the *gathering architecture* is real and proven; there is no real document store to gather from yet (Help Center §24, Google Drive/Docs integration §33 both don't exist) | A real `knowledge_sources`/`knowledge_documents` table + embedding pipeline, with retrieved-snippet provenance (source name + article/doc link) surfaced to both the AI prompt and, optionally, the human | `knowledge_sources`, `knowledge_documents` (+ embeddings, likely pgvector) | Yes | Yes | Yes (source picker in Settings) | No | Yes | Plan-gated by source count/storage | Tenant isolation on retrieval (critical — never leak one tenant's docs into another's AI context) | Phase D | PARTIALLY PRESENT |

## 27. AI Handoff

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Structured handoff classification | Not a single native Chatwoot model — assembled from automation rules + agent bot webhooks | `ai_mode` HUMAN_TAKEOVER exists as a real state, but is only ever toggled manually by a human today — nothing *automatically* flips it | Real state, no automatic classifier | A real classification step (regex/keyword pass first — reusing the existing two-stage Sentinel pattern — then Gemini for ambiguous cases) that can automatically set HUMAN_TAKEOVER and records why | `handoff_events` table (`reason`, `trigger`, `chat_id`, `ai_agent_id`, `timestamp`, `acknowledged_by`) | Yes (extends the existing Sentinel + `aiReplyService`) | Yes | Yes (badge/alert in ChatThread) | No | Yes | Included | Tenant isolation | Phase B | PARTIALLY PRESENT |

## 28. Voice / Calling

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Call metadata / history | `Call` (**enterprise**, `enterprise/app/models/call.rb`): `direction`, `duration_seconds`, `status`, `provider` (Twilio), `transcript` — this is Chatwoot's own **separate Twilio-voice-channel** feature, not WhatsApp calling | `whatsapp_calls` (migration 012): real Baileys call-event ingestion (`offer`/`ringing`/`accepted`/`rejected`/`ended`), full history UI (`CallHistoryPanel`) | Fully real and, for its actual scope (WhatsApp call *events*, not Twilio voice), already complete | None on the metadata side | — | — | — | — | Yes | No | Included | Tenant isolation (already enforced) | — | FULLY PRESENT (for WhatsApp call metadata) |
| Answer / place a live WhatsApp call with real audio | N/A — Chatwoot's Call model is Twilio PSTN, not a WhatsApp calling API at all | None | Not built | **Baileys (this connector) does not expose a WhatsApp voice/video call transport** — it can observe call *signaling* events (already ingested) but cannot originate or carry call audio. This is a genuine WhatsApp-protocol/connector ceiling, not a missing WhatchatAI feature | N/A | N/A | N/A | N/A | Yes — blocked entirely by connector capability | No | N/A | N/A | — | UNSUPPORTED BY CURRENT WHATSAPP CONNECTOR |

## 29. Notifications

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Unified notification center | `Notification`/`NotificationSetting`/`NotificationSubscription` (core/MIT): `notification_type` enum, `primary_actor`/`secondary_actor` polymorphic, `read_at`, `snoozed_until`, per-user subscription prefs | `AlertNotifier.tsx` exists today for exactly one event type (human-takeover security alerts, via `GET /api/security/alerts/human-takeover`) | Partial — the pattern (real backend-driven alert, real frontend notifier) is proven for one event; not generalized | A real `notifications` table + one dispatch point covering new conversation/message/mention/assignment/lead/automation-failure/AI-failure/sync-failure/CSAT/SLA-breach — reusing the existing WebSocket transport for delivery, not a second push mechanism | `notifications` table | Yes (generalizes the existing alert pattern) | Yes | Yes (notification center UI) | No | Some triggers are AI-classified | Included | Tenant isolation | Phase B | PARTIALLY PRESENT |

## 30. Security / Audit

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Audit logging | Standard Rails app-level logging + `AccountSamlSettings` (**enterprise**, SSO) | `security_audit_logs` (migration 028): real, already-populated audit trail for lock/unlock events | Real but narrow-scoped (screen-lock events only) | Extend the same table's event-type vocabulary to cover auth (once §6 exists), data export, permission changes, integration connects | Extend existing table's enum, no new table | Yes | Yes | Yes (audit log viewer) | No | No | Included | This *is* the security requirement | Phase B | PARTIALLY PRESENT |
| Message encryption at rest | Not a Chatwoot concern at this granularity (Postgres-level encryption, if any, is deployment-specific) | AES-256-GCM envelope encryption on every message body, with Redis-cached DEKs (`EncryptionService`, already implemented and wired into `whatsappMessageRepository`) | Fully real | None | — | — | — | — | No | No | — | AES-256-GCM, envelope encryption | — | BETTER IN WHATCHATAI |
| SSO / SAML | `AccountSamlSettings` (**enterprise**) | None | Not built | Full SAML/SSO integration, blocked on §6 (users) existing first | New table | Yes | Yes | Yes | No | No | Top-tier plan gate | Must be implemented correctly or not at all — no partial SSO | Phase D | MISSING |

## 31. Admin

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Business profile / plan / account admin | `InstallationConfig`, `SuperAdmin`, account settings | `GET/PATCH /api/workspace/business` (real rename), `GET /api/workspace/billing` (real plan/usage view), `SettingsRoute.tsx` (real, comprehensive: theme, business profile, WhatsApp account incl. real photo change synced to WhatsApp, screen-lock management) | Fully real for a single-operator business; no cross-business platform-admin surface (not needed until multiple paying tenants exist operationally) | Platform-level admin console (view all tenants, plan overrides, suspend) | New admin-only tables/flags | Yes | Yes | Yes | No | No | Platform-operator only, not customer-facing | Strict RBAC — must never be reachable by a tenant's own users | Phase E (SaaS operations) | PARTIALLY PRESENT |

## 32. Import / Migration

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CSV/external contact import | `DataImport`/`DataImportError`/`DataImportItem`/`DataImportMapping` (core/MIT): `source_provider`, `cursor` jsonb (resumable), `stats` jsonb, per-row error tracking | None — but conceptually less needed here, since WhatsApp's own sync (`whatsappSyncService`) is already the real "import" path for contacts/chats/messages | N/A for WhatsApp data (already covered); real gap only for *external* CRM import (e.g. migrating from a spreadsheet or another CRM) | A CSV contact importer writing into `crm_contacts`, with the same resumable/error-tracked shape Chatwoot uses | `data_imports` table | Yes | Yes | Yes | No | No | Plan-gated | Tenant isolation; never let an import silently overwrite mapped WhatsApp identity fields | Phase D | MISSING (external import only — WhatsApp-native "import" already fully solved by the sync engine) |

## 33. Search

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Global search (contacts/conversations/messages) | Postgres full-text search across `Contact`/`Conversation`/`Message` | Chat list has real client-side name filtering only (`ChatListPane.tsx`'s `search` state); `whatsapp_contacts.search()` repository method exists but isn't exposed as a global search endpoint | Partial — a real contact-search query exists in the repository layer, unused by any route | `GET /api/workspace/search?q=` spanning contacts + message text (message bodies are encrypted at rest, so full-text search needs either a decrypt-then-filter pass or a searchable-plaintext index with its own security review) | Possibly a `pg_trgm`/tsvector index; must respect encryption | Yes | Yes | Yes (global search bar) | No | No | Included | Must not defeat message-encryption-at-rest by indexing plaintext insecurely | Phase B | PARTIALLY PRESENT |

## 34. Collaboration

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Real-time presence / "who's viewing this conversation" | Chatwoot's ActionCable presence channel | None (blocked on §6 users existing) | Not built | Depends on §6 | Reuses existing WebSocket transport | Yes | Yes | Yes | No | No | Included | Tenant isolation | Phase B | MISSING |

## 35. Integrations

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Slack | `app/jobs/send_on_slack_job.rb`, `lib/integrations/slack/*` (core, real OAuth-based bridge) | None | Not built | Real Slack OAuth app + webhook bridge for internal team notifications (mentions, handoffs) | `integration_connections` table (provider, tokens, scopes) | Yes | Yes | Yes | No | No | Plan-gated | OAuth token storage must be encrypted at rest (reuse `EncryptionService`) | Phase D | MISSING |
| Shopify | `app/controllers/shopify/*`, `app/controllers/webhooks/shopify_controller.rb` (core) | None | Not built | Order/customer lookup surfaced into the CRM context for a WhatsApp conversation | Same `integration_connections` pattern | Yes | Yes | Yes | No | No | Plan-gated | Same as above | Phase D | MISSING |
| Linear | `lib/linear.rb`, `app/controllers/linear/*` (core) | None | Not built | Create/link Linear issues from a conversation (e.g. bug reports) | Same pattern | Yes | Yes | Yes | No | No | Plan-gated | Same as above | Phase D | MISSING |
| Google ecosystem (Drive/Sheets/Gmail/Calendar/Docs/etc.) | Not a Chatwoot capability at all — this is WhatchatAI's own stated roadmap | None built yet | Not built | Real OAuth per Google product, most immediately valuable as a §26 knowledge source (Drive/Docs) and a §17 automation action (Sheets logging, Calendar booking) | Same `integration_connections` pattern | Yes | Yes | Yes | No | Yes (knowledge retrieval) | Plan-gated | OAuth token encryption, least-privilege scopes | Phase D | MISSING — WHATCHATAI-UNIQUE (no Chatwoot equivalent) |
| Translation | Google Translate integration (core) | None | Not built | Real translate-on-demand for both inbound (agent reading) and outbound (AI/agent replying in the customer's language) — Gemini itself can do this without a separate Translate API call | None new | Yes (new `aiReplyService` sibling method) | Yes | Yes | No | Yes | Included | Tenant isolation | Phase C | MISSING |
| Dashboard apps (embed a third-party panel) | `DashboardApp`/`platform_app.rb` (core) | None | Not built | Lower priority — a generic iframe-embed panel framework | `dashboard_apps` table | Yes | Yes | Yes | No | No | Plan-gated | iframe sandboxing, CSP | Phase E | MISSING |

## 36. Webhooks / API

| Feature | Chatwoot Capability | WhatchatAI Capability | Current Implementation | Gap | Required DB | Required Backend | Required API | Required UI | WhatsApp Dependency | AI Dependency | Plan Entitlement | Security Requirement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Outbound webhooks | `Webhook` (core/MIT, `app/models/webhook.rb`): `url`, `secret`, `subscriptions` jsonb, per-account or per-inbox, `WebhookSecretable` (HMAC signing) | None | Not built | Real webhook dispatch (message received, conversation resolved, lead created, etc.) with HMAC-SHA256 signing, matching Chatwoot's own `WebhookSecretable` shape conceptually | `webhooks` table | Yes | Yes | Yes | No | No | Plan-gated | HMAC signing, retry-with-backoff, per-tenant delivery isolation | Phase D | MISSING |
| Public API (tokens, businesses acting programmatically) | `AccessToken` (core/MIT) + full REST API surface | None — today's `/api/workspace/*` routes are session/cookie-scoped to the single connected business, not a public token-authenticated API | Not built as a public API | Real API-key issuance + a token-authenticated subset of the existing `/api/workspace/*` routes, rate-limited | `api_tokens` table | Yes | Yes (mostly reuses existing route handlers behind a new auth strategy) | Yes (token management UI) | No | No | Plan-gated (rate limits by tier) | Token hashing at rest, rate limiting, full audit log | Phase D | MISSING |

## 37. Notifications (cross-reference) — see §29 above.

## 38. Search (cross-reference) — see §33 above.

## 39. Import/Migration (cross-reference) — see §32 above.

---

*Companion document:* [`chatwoot-whatchatai-final-gap-audit.md`](./chatwoot-whatchatai-final-gap-audit.md)
carries the per-category decision (`IMPLEMENT NOW` / `IMPLEMENT LATER` / `ADAPT` /
`REPLACE WITH BETTER WHATCHATAI VERSION` / `UNSUPPORTED` / `NOT APPLICABLE`),
the unified data-model design, and the final structured report.
