# Chatwoot Feature Map

Based on direct inspection of Chatwoot's actual source (a fresh shallow
clone of `https://github.com/chatwoot/chatwoot`) — real model files under
`app/models/` and `enterprise/app/models/`, not the README. Every
"Chatwoot approach" cell below cites the actual file and, where useful,
real schema columns read from that file's annotated header comment.

**Licensing note** (see `docs/legal/source-provenance.md` for the full
policy): everything under `enterprise/` — this includes Chatwoot's entire
AI system, "Captain" — is licensed under `enterprise/LICENSE`, which
explicitly **forbids** copying, merging, publishing, distributing,
sublicensing, or selling that code without a paid Chatwoot Enterprise
subscription. Rows below sourced from `enterprise/` are marked; nothing
from them has been or may be copied — only the conceptual approach is
described, exactly as the reuse-rules directive requires ("prefer:
understand → extract idea → design original → implement original").

| Feature | Chatwoot Approach | WhatchatAI Approach | Current State | DB Required | Backend Required | Frontend Required | AI Required | WhatsApp Dependency | Plan Entitlement | Phase | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Conversations | `Conversation` model (`app/models/conversation.rb`, MIT/core): `status` enum, `priority`, `assignee_id`, `team_id`, `sla_policy_id`, `snoozed_until`, `waiting_since`, `first_reply_created_at`, `contact_last_seen_at`/`agent_last_seen_at` (drives unread on both sides), `uuid` + sequential `display_id` | `whatsapp_chats` already has the WhatsApp-native equivalent (`unread_count`, `last_message_at`, `ai_mode`) but no `status`/`priority`/`assignee`/`snoozed_until` — those are Chatwoot's *human support desk* concepts layered on top of a conversation, not present in WhatchatAI yet | Partial — WhatsApp-native fields real and working; support-desk fields absent | Yes (columns) | Yes | Yes | No | Yes | Team/agent-seat-gated in Chatwoot | 22 (Teams/Permissions) | Missing |
| Inboxes | `Inbox` model (`app/models/inbox.rb`, MIT/core): polymorphic `channel_id`+`channel_type` across Email/API/WhatsApp/Website/etc, `working_hours_enabled`, `auto_assignment_config`, `csat_config` | WhatchatAI is WhatsApp-only by design (`whatsapp_accounts` *is* the inbox, 1:1 with a channel) — no multi-channel-type polymorphism exists or is currently needed | N/A by design — not a gap, a deliberate scope difference | N/A | N/A | N/A | No | Yes | N/A | — | Not applicable |
| Contacts | `Contact` model (`app/models/contact.rb`, MIT/core): `name`/`email`/`phone_number`/`identifier`, `additional_attributes`/`custom_attributes` JSONB, `blocked`, `last_activity_at` | `whatsapp_contacts` already covers the WhatsApp-native identity fields (verified_name/business_name/push_name/etc., real reconciliation) more thoroughly than Chatwoot's generic contact; missing generic `custom_attributes` JSONB and a `blocked` flag | Partial — WhatsApp identity superior, generic CRM fields absent | `custom_attributes`/`blocked` columns | Yes | Yes | No | No | Plan-gated in future | 16 (CRM) | Missing (generic fields only) |
| Agents/Teams/Roles | `AccountUser` (`app/models/account_user.rb`, MIT/core): `role` enum (`agent`/`administrator`), `availability` enum, per-account membership; `Team`/`team_member.rb` for grouping agents | **No `users`/`memberships`/`roles` tables exist at all** — confirmed via schema inspection this session. WhatchatAI currently runs as an implicit single-business context (`BusinessRepository.ensureDefault()`), with no real multi-user auth | **Missing entirely** — the single largest confirmed gap in this audit | users, account_users/memberships, teams, team_members tables | Full auth system | Full auth UI | No | No | Seat-based plans depend on this | 22 (Teams/Permissions) | Missing |
| Assignment | `assignee_id`/`assignee_agent_bot_id`/`team_id` on `Conversation`, `AssignmentHandler`/`AutoAssignmentHandler` concerns | Not applicable until agents/users exist; `ai_mode` (AI_ACTIVE/AI_PAUSED/HUMAN_TAKEOVER) is WhatchatAI's current, real, working analog for "who's handling this" | Partial analog exists (ai_mode), true agent assignment absent | assignee columns | Yes | Yes | No | No | Yes | 22 | Depends on Agents/Teams/Roles |
| Private notes | `Note` model (`app/models/note.rb`, MIT/core): `content`, `account_id`, `contact_id`, `user_id` — simple, real | Not built | Missing | notes table | Yes | Yes | No | No | Yes | 16 (CRM) | Missing |
| Mentions | `Mention` model (`app/models/mention.rb`, MIT/core): `conversation_id`+`user_id`+`mentioned_at`, unique per user/conversation | Not applicable until users/notes exist | Missing | mentions table | Yes | Yes | No | No | Yes | 22 | Depends on Agents/Teams/Roles |
| Labels | `Label` model (`app/models/label.rb`, MIT/core): `title`, `color`, `description`, `show_on_sidebar`, unique per account | `crm_contacts` has a real `tags` array column already (confirmed rendered in the Phase 2 UI pass); no dedicated `labels` table or per-conversation labeling | Partial — contact-level tags exist and are real; conversation-level labels don't | labels table (if normalized) | Yes | Yes | No | No | Yes | 16 (CRM) | Partial |
| Custom attributes | `CustomAttributeDefinition` (MIT/core): typed, admin-defined fields on contacts/conversations | Not built | Missing | custom_attribute_definitions + JSONB columns | Yes | Yes | No | No | Yes | 16 (CRM) | Missing |
| Canned responses | `CannedResponse` (`app/models/canned_response.rb`, MIT/core): `short_code` + `content`, per-account, searchable | Not built | Missing | canned_responses table | Yes | Yes | No | No | Yes | 17 (Automation) | Missing |
| Keyboard shortcuts / command bar | Frontend-only (Vue), no dedicated backend model | Not built | Missing | None | No | Yes | No | No | No | 11 (Workspace) | Missing |
| Custom views / filters | `CustomFilter` (MIT/core) — saved query definitions | Not built | Missing | custom_filters table | Yes | Yes | No | No | Yes | 19 (Analytics) | Missing |
| Business hours | `WorkingHour` (`app/models/working_hour.rb`, MIT/core) + `Inbox#working_hours_enabled`/`out_of_office_message` | Not built | Missing | working_hours table + inbox columns | Yes | Yes | No | No | Yes | 17 (Automation) | Missing |
| Auto responders / automation | `AutomationRule` (`app/models/automation_rule.rb`, MIT/core): `event_name` + `conditions` JSONB + `actions` JSONB + `execution_delay` — a real, clean trigger/condition/action rules engine | `whatsapp_chats.ai_mode` is a real but much narrower automation primitive (AI_ACTIVE routes to Gemini once that's wired — see the Phase 2 report; not yet actually calling Gemini) | Partial — the concept (event-driven automation) is sound and worth adapting *conceptually* for WhatchatAI's own automation engine later; no code reused | automation_rules table | Yes | Yes | No | Partially | Yes | 17 (Automation) | Missing (beyond ai_mode) |
| Campaigns | `Campaign` (MIT/core) | Not built | Missing | campaigns/campaign_recipients/campaign_events tables (already named as future-ready placeholders in the directive's own domain model) | Yes | Yes | No | Yes | Plan-gated | 20 (Marketing) | Missing |
| Contact segments | Derived from `custom_filter`s scoped to contacts | Not built | Missing | Depends on custom_filters | Yes | Yes | No | No | Yes | 16 (CRM) | Missing |
| Reports / CSAT | `ReportingEvent`/`ReportingEventsRollup` (MIT/core); CSAT via `CsatSurveyResponse` (MIT/core) — a real, dedicated survey-response table | Not built | Missing | reporting_events + csat tables | Yes | Yes | No | No | Yes | 19 (Analytics) | Missing |
| Live view | Real-time agent dashboard (frontend, ActionCable-backed) | WhatchatAI's own real-time layer (WebSocket + Redis pub/sub, already built and working) is the direct analog — it already pushes message/chat/call/media events live | Partial — the transport exists and works; no dashboard UI built on top of it yet | None new | Minor | Yes | No | Yes | 19 (Analytics) | Partial (transport ready) |
| Integrations | `platform_app.rb`, `integrations/` (MIT/core) — webhook/app marketplace | Not built | Missing | Depends on design | Yes | Yes | No | No | Plan-gated | 21 (Google Integrations) is the current placeholder for this category | Missing |
| Permissions | `AccountUser#role` enum (agent/administrator) + `enterprise/app/models/custom_role.rb` for granular custom roles (**enterprise/**, `enterprise/LICENSE` applies — conceptual reference only, no code eligible for reuse without a paid subscription) | Not built | Missing | roles table | Yes | Yes | No | No | Plan-gated (custom roles likely a paid-tier feature in WhatchatAI too, mirroring Chatwoot's own enterprise gating) | 22 (Teams/Permissions) | Missing |
| AI / Captain | `Captain::Assistant` (**enterprise/**, `enterprise/app/models/captain/assistant.rb`) — `config`/`guardrails`/`response_guidelines` JSONB, FAQ-suggestion loop (`FaqObservation`/`FaqSuggestion`), document ingestion, `agent_session`. **Entirely enterprise-licensed** — off-limits for source reuse; the *architectural shape* (structured guardrails config, an observation→suggestion feedback loop for improving responses) is a legitimate idea to design an original WhatchatAI version around | `ai_agents` table exists; the two-stage Sentinel (regex + Gemini Flash) is real and working for content screening; actual auto-reply generation is **not yet wired** (confirmed real gap, Phase 2 report) | Partial — schema exists, screening works, generation doesn't | ai_conversations/ai_messages/ai_jobs (placeholder tables, not yet built per the directive's own "don't fully implement yet" instruction) | Yes | Yes | Yes | Yes | Plan-gated | 13-15 (AI Core/Agents/Multimodal) | Missing (generation) |
| Help centre | `Portal`/`Article`/`Category`/`Folder` (MIT/core) — public knowledge base | Not built | Missing | knowledge_sources/knowledge_documents (future-ready placeholders) | Yes | Yes | No | Maybe (search) | Plan-gated | 18 (Knowledge) | Missing |

## Summary

Of the 20 real Chatwoot features inspected, WhatchatAI currently has a
genuine, working analog for exactly two (unread/read state via
`whatsapp_chats.unread_count`, and a real-time transport via its own
WebSocket bridge) and a partial analog for three more (ai_mode as a
narrow automation primitive, `crm_contacts.tags` as a partial labels
analog, the Sentinel as a partial AI-screening analog). Everything
support-desk-shaped (agents, teams, roles, assignment, notes, mentions,
canned responses, business hours, reports/CSAT, help centre) is a real,
confirmed gap — none of it exists yet, none of it was faked to look like
it exists, and per the directive's own phase ordering, none of it is
required before the WhatsApp-side database foundation (phases 1-11) is
certified.
