# Chatwoot ↔ WhatchatAI Final Gap Audit & Decision Record

**Companion document.** This file assumes
[`chatwoot-whatchatai-capability-gap.md`](./chatwoot-whatchatai-capability-gap.md)
(the 39-section, row-by-row matrix) has already been read — every count,
decision, and gap listed below is derived directly from that matrix's 68
audited feature rows, not re-researched from scratch. Where this document
says "row N," it means row N of that matrix in reading order.

This document adds the three things the matrix intentionally left out: a
single **IMPLEMENT NOW / IMPLEMENT LATER / ADAPT / REPLACE WITH BETTER
WHATCHATAI VERSION / UNSUPPORTED / NOT APPLICABLE** decision per category
with rationale, the **unified data-model design**, and the **final
structured report**.

---

## 1. Scope honesty

Zero implementation has happened in this audit pass. Everything below is
research and decision-making, delivered as the directive's own "MANDATORY
CURRENT TASK" section scoped this pass to be, and consistent with
"IMPLEMENT IN SLICES" from the directive's "IMPLEMENTATION STRATEGY"
section. No schema migration, backend service, API route, or UI component
was written or changed while producing either audit document. The
CHATWOOT CAPABILITY MERGER status is therefore **IN PROGRESS**, not
COMPLETE — the audit is complete, the merger itself has not started.

---

## 2. Per-category decision matrix

Decision values used: **IMPLEMENT NOW** (build in the very next slice, no
blocking dependency), **IMPLEMENT LATER** (real, wanted, blocked on a
dependency or intentionally sequenced), **ADAPT** (Chatwoot's shape is
useful but must be reworked to fit WhatchatAI's actual architecture, not
copied), **REPLACE WITH BETTER WHATCHATAI VERSION** (WhatchatAI's existing
or planned approach is architecturally superior — usually because it's
grounded in the real WhatsApp thread instead of a generic model),
**UNSUPPORTED** (a genuine WhatsApp-protocol or Baileys-connector ceiling,
not a product decision), **NOT APPLICABLE** (the underlying problem
doesn't exist in a WhatsApp-first, single-thread-per-customer product).

| § | Category | Decision | Phase | Rationale |
|---|---|---|---|---|
| 1 | Inbox | ADAPT | A | The polymorphic "inbox as channel container" concept is NOT APPLICABLE (row 1) — `whatsapp_accounts` already *is* the inbox. But the two real sub-capabilities it carries — working-hours config and multi-inbox (multi-number) routing — are wanted; they get adapted onto `whatsapp_accounts` rather than a new `Inbox` model. |
| 2 | Conversations | ADAPT + REPLACE WITH BETTER | A (status fields) / B (participants) | Chatwoot's `status`/`priority`/`snoozed_until` fields get added directly to `whatsapp_chats` — never a second `conversations` table (row 47's explicit warning). The message-store side (row 50) is already better in WhatchatAI and needs no action. |
| 3 | Contacts | ADAPT + REPLACE WITH BETTER | A | `crm_contacts` already beats `Contact#custom_attributes` (row 57, BETTER IN WHATCHATAI). Only `blocked` (row 59) is a real, cheap, safety-relevant gap — IMPLEMENT NOW inside this category. |
| 4 | Companies | IMPLEMENT LATER | C | Chatwoot itself gates this behind Enterprise licensing, and the directive explicitly forbids forcing a company structure onto individual consumer WhatsApp users. Nullable `company_id`, opt-in, B2B-tier only. |
| 5 | Teams | IMPLEMENT LATER | B | Structurally simple, but meaningless until §6 (Users) exists — a team is a set of users. |
| 6 | Agents / Users / Roles | IMPLEMENT NOW | B (foundational) | This is the single largest confirmed gap (row 78) and it blocks eleven other categories (§5, §7, §9, §10, §14 partially, §23, §29 partially, §30 partially, §34, §35 partially). It is the correct next slice after Phase A, ahead of everything else it unblocks. The screen-lock PIN sub-row is already REPLACE WITH BETTER WHATCHATAI VERSION (shipped) and needs no further action. |
| 7 | Assignment | ADAPT | B | Extend `whatsapp_chats` with `assignee_user_id`/`assignee_team_id` alongside the existing, working `ai_mode` column — the AI-vs-human axis (row 86) stays as-is; only the human-to-human axis is new. Policy engine (row 87) is IMPLEMENT LATER, Phase C. |
| 8 | Agent Capacity | IMPLEMENT LATER | C | Mirrors Chatwoot's own enterprise gating — a real feature, but a top-tier upsell, not core. |
| 9 | Private Notes | IMPLEMENT LATER | B | The `notes` free-text field (row 100) already covers the minimum case; a real threaded `conversation_notes` table needs `author_user_id`, so it waits immediately behind §6. |
| 10 | Mentions | IMPLEMENT LATER | B | Directly depends on §6 + §9. |
| 11 | Labels | IMPLEMENT NOW | A | Independent of Users — `crm_contacts.tags` (row 112) already proves the storage pattern; only a real catalog table (title/color/description) plus a join table is missing. No blocking dependency. |
| 12 | Custom Attributes | IMPLEMENT NOW | A | Same shape as Labels — `custom_fields` jsonb (row 118) already stores values; only the admin-defined typing/definition layer is missing. No blocking dependency. |
| 13 | Canned Responses & Macros | SPLIT: Canned Responses IMPLEMENT NOW / Macros IMPLEMENT LATER | A / B | Canned responses are a standalone, low-risk, high-value slice. Macros need labels (§11) and assignment (§7) to have real actions to execute — sequenced right after those land. |
| 14 | Custom Views & Filters | IMPLEMENT LATER | B | The filter-condition evaluator is infrastructure reused by §17 automation conditions and §19 segments — worth building once, correctly, rather than three times. Building it in Phase B means Phase C features can reuse it immediately. |
| 15 | Business Hours | IMPLEMENT NOW | A | Standalone, and a real dependency of §16 (auto-responders), §22 (CSAT timing), and §23 (SLA `only_during_business_hours`). Front-loading it avoids rework later. |
| 16 | Auto Responders | ADAPT | A | Extends the already-hardened `aiReplyService.ts` (this session's `thinkingBudget:0`/`maxOutputTokens` fix) with a business-hours-aware branch — not a new AI pipeline. |
| 17 | Automations & Conversation Workflows | IMPLEMENT LATER | C | Needs the §14 filter engine and §13 macro action-executor as building blocks; building the general `AutomationRule`-equivalent before those exist would mean rebuilding it. |
| 18 | Campaigns | ADAPT — WITH GUARDRAILS | D | Real demand, real WhatsApp-ban risk (row 158). Decision is to build it, but only as opt-in, rate-limited, reply-to-known-contacts-only, reusing the exact `whatsapp_outbound_messages` status pipeline already tested this session — never a bulk cold-blast tool. |
| 19 | Segments | IMPLEMENT LATER | C | Trivial once §14's filter engine exists — a segment is just a saved contact-scoped filter. |
| 20 | Live View | REPLACE WITH BETTER WHATCHATAI VERSION | C | The transport (real WebSocket + Redis pub/sub, row 171) is already proven and superior to needing a fallback poll; only the aggregate *view* on top is missing. |
| 21 | Reports | IMPLEMENT LATER | C (rollup events) / D (per-agent/team/label breakdowns, CSV export) | `getDashboardOverview()` (row 177) already computes real live aggregates — no urgency to add a parallel rollup-event log until historical trending is actually requested; breakdowns wait on §6/§11/§18 existing. |
| 22 | CSAT | IMPLEMENT LATER | C | Real value, needs §15 (business hours) and a resolve-state (§2) to trigger from. |
| 23 | SLA | IMPLEMENT LATER | D | Chatwoot gates this at Enterprise tier; WhatchatAI mirrors that as a top-tier plan gate. Needs §15 to be meaningful. |
| 24 | Help Center | IMPLEMENT LATER | D | Feeds §26 (AI knowledge) directly — sequenced together. |
| 25 | Captain-style AI Assistance | ADAPT + REPLACE WITH BETTER | C | WhatchatAI's autonomous `aiReplyService` (row 204) already does more than Chatwoot's Copilot in AI_ACTIVE mode. The gap is a "suggest, don't send" variant for HUMAN_TAKEOVER — a new mode on the existing engine, not a new engine. |
| 26 | AI + Knowledge Sources | IMPLEMENT LATER | D | `aiContextGathererService.ts`'s parallel-gather architecture (row 212) is already real and already honestly stubs the missing knowledge branch — the remaining work is populating a real document store, which needs §24 and/or §35's Google Drive/Docs integration first. |
| 27 | AI Handoff | IMPLEMENT LATER | B | Extends the existing two-stage Sentinel pattern and the real `ai_mode` HUMAN_TAKEOVER state (row 218) with automatic classification — natural Phase B work alongside §6/§29. |
| 28 | Voice / Calling | Metadata: REPLACE WITH BETTER (done) / Live call audio: UNSUPPORTED | — | Call metadata (row 224) is already FULLY PRESENT and exceeds Chatwoot's Twilio-PSTN scope for its actual purpose. Live call answering (row 225) is a genuine Baileys/WhatsApp-protocol ceiling — the directive's own instruction ("do NOT copy a call UI without implementing the underlying transport") is already being honored: no fake "answer call" button exists anywhere in the UI today. |
| 29 | Notifications | IMPLEMENT LATER | B | Generalizes the proven `AlertNotifier.tsx` pattern (row 231) from one event type to a real table-backed multi-type system, over the existing WebSocket transport — no new delivery mechanism needed. |
| 30 | Security / Audit | Audit log: IMPLEMENT LATER (B) / Encryption: REPLACE WITH BETTER (done) / SSO: IMPLEMENT LATER (D) | B / — / D | `security_audit_logs` (row 237) already has the right shape; only its event-type vocabulary needs extending once §6 exists. Encryption already exceeds Chatwoot (row 238). SSO is real but blocked on §6 and is a top-tier-only feature even in Chatwoot. |
| 31 | Admin | IMPLEMENT LATER | E | A platform-operator console is only operationally necessary once there are enough paying tenants to need one — explicitly the last phase. |
| 32 | Import / Migration | WhatsApp-native: NOT APPLICABLE / External CSV: IMPLEMENT LATER | — / D | The WhatsApp sync engine (row 251) already *is* the import path for WhatsApp-native data — building a second import mechanism for it would be redundant. External CRM/spreadsheet import is a real, separate, lower-priority gap. |
| 33 | Search | IMPLEMENT LATER | B | `whatsapp_contacts.search()` (row 257) already exists in the repository layer and only needs a route; sequenced into Phase B because message-body search requires a careful design decision about not defeating the existing at-rest encryption. |
| 34 | Collaboration | IMPLEMENT LATER | B | Presence reuses the existing WebSocket transport; blocked purely on §6 Users existing to have something to show presence *of*. |
| 35 | Integrations | Slack/Shopify/Linear/Google: IMPLEMENT LATER / Translation: REPLACE WITH BETTER / Dashboard apps: IMPLEMENT LATER | D (C for Translation, E for Dashboard apps) | All external integrations share one `integration_connections` OAuth-token pattern (rows 269-274) — worth building once as shared infrastructure, then adding providers. Translation specifically should route through Gemini directly (already the AI provider in use) rather than adding a second Google Translate API integration — genuinely simpler and better than Chatwoot's approach. Google ecosystem (Drive/Sheets/Gmail/Calendar/Docs/etc.) has no Chatwoot equivalent at all — it's WhatchatAI's own roadmap item riding the same integration infrastructure. Dashboard apps (generic iframe embeds) are lowest priority — deferred to Phase E alongside the admin console. |
| 36 | Webhooks / API | IMPLEMENT LATER | D | Real, wanted, but correctly sequenced after the features that would actually emit webhook-worthy events (assignment, automation, campaigns) exist. |

---

## 3. Unified data-model design

The directive's target chain is:

```
BUSINESS → WHATSAPP ACCOUNT → CUSTOMER → CONVERSATION → MESSAGES
  → AI → CRM → LEAD → TASK → AUTOMATION → ANALYTICS → REPORTING
```

Mapped against what's real today, with the "one canonical customer, one
canonical conversation, never a duplicate model" rule enforced throughout:

| Chain link | Current real table(s) | Status | Design rule going forward |
|---|---|---|---|
| BUSINESS | `businesses` | Real | Root tenant boundary — every new table below carries `business_id` and every query filters on it (already the codebase's enforced convention). |
| WHATSAPP ACCOUNT | `whatsapp_accounts` | Real | Stays the "inbox." Multi-account (§1) adds more rows, never a second concept. |
| CUSTOMER | `whatsapp_contacts` (WhatsApp identity) + `crm_contacts` (business/CRM identity), joined 1:1 on contact id | Real, already unified | **This is already correct and must stay this way.** The directive's core fear — "never build separate Chatwoot contacts and WhatsApp contacts" — is already avoided: there is one contact row with WhatsApp-native fields and CRM fields on the same identity, not two tables pretending to be independent systems. §4 Companies attaches here via a nullable FK, never a required one. |
| CONVERSATION | `whatsapp_chats` | Real, needs extension | Gets `status`/`priority`/`snoozed_until`/`assignee_user_id`/`assignee_team_id` columns added directly (§2, §7) — it does **not** get replaced or duplicated by a Chatwoot-shaped `conversations` table. One chat row per WhatsApp thread remains the single source of truth for "what is this conversation's state." |
| MESSAGES | `whatsapp_messages` | Real, AES-256-GCM encrypted at rest | No gap. Already exceeds Chatwoot's own security posture (row 238). |
| AI | `ai_agents`, `aiReplyService.ts`, `aiContextGathererService.ts` | Real | Gains a "suggest, don't send" mode (§25), automatic handoff classification (§27), summarization (§25), translation (§35), and eventually knowledge retrieval (§26) — all as new capabilities on the existing service, not a parallel AI system. |
| CRM | `crm_contacts` | Real | Gains typed custom-attribute *definitions* (§12) on top of its existing free-form `custom_fields`, and a real `labels` catalog (§11) replacing the ad-hoc `tags` array as the canonical tagging mechanism (tags migrate into label assignments, not a second tagging system). |
| LEAD | `crm_contacts.stage`/`lead_status` (leads are a state on the same customer row, not a separate table) | Real | Confirmed correct: Chatwoot has no native lead-pipeline concept at all — this is a WhatchatAI original that already avoids the "separate CRM lead object" trap. |
| TASK | Not yet built | Gap, not covered by any single Chatwoot model directly (composed from macros/automation in Chatwoot) | When built, tasks attach to the CUSTOMER row (via `crm_contacts.id`), never to a separate "deal" or "ticket" object — consistent with the "WhatsApp conversation is the center of the business record" principle. |
| AUTOMATION | Only `ai_mode` today (a narrow, real, single-purpose automation primitive) | Partial | §17's `automation_rules` + §13's macro action-executor + §14's filter evaluator combine into the real engine: `TRIGGER → CONDITIONS → AI/RULE DECISION → ACTIONS → AUDIT → RESULT`, exactly as the directive specifies. Every action type must be a real, executing function (assign, label, send canned response, create task, change lead stage) — never a UI action that logs an "action" row without doing anything. |
| ANALYTICS | `getDashboardOverview()` (real, computed live from source tables) | Real for live numbers, no historical log yet | §21's `reporting_events` table adds a real event-emission point at each meaningful state change — additive, not a replacement for the live aggregate queries that already work. |
| REPORTING | `SettingsRoute.tsx`/dashboard pages | Partial | CSV export and per-agent/team/label/campaign breakdowns (§21) read from the same source tables reports already read from — never a separately maintained export dataset that can drift from the truth. |

**The one invariant that must never be violated across every phase above:**
a WhatsApp customer is one row (`whatsapp_contacts` ⋈ `crm_contacts`), a
WhatsApp thread is one row (`whatsapp_chats`), and every new feature —
Teams, Labels, Automation, Campaigns, Reports — attaches to those two rows
rather than inventing a parallel identity or thread concept. This is the
literal implementation of the directive's "DO NOT CREATE A SECOND PRODUCT
INSIDE THE PRODUCT" rule.

---

## 4. Licensing summary

Chatwoot's `enterprise/` tree (`enterprise/LICENSE`) forbids production use
without a paid Chatwoot Enterprise subscription; dev/testing use is
explicitly permitted. As of the commit audited (`e52a731b`, 2026-08-17),
**Companies, SLA, Agent Capacity Policies, Custom Roles, Calling
(Twilio-based), and Copilot** are confirmed to live under `enterprise/`.
None of this repository's design decisions above reuse any code, schema
DDL, migration file, or file content from `enterprise/` — only the
conceptual shape (which columns and relationships a mature version of the
feature needs) informed the WhatchatAI-original designs in §2 and §4-6.
This mirrors the plan-gating Chatwoot itself applies: Companies, SLA,
Agent Capacity, and Custom Roles are all marked as higher-tier or top-tier
plan-gated in the decision matrix above, deliberately following Chatwoot's
own signal about which features are advanced/premium rather than core.

---

## 5. Phase roadmap

- **Phase A — Support Desk Core:** Business hours, labels catalog, custom
  attribute definitions, canned responses, conversation status/snooze,
  blocked-contact flag, auto-responder business-hours branch.
- **Phase B — Identity & Collaboration Foundation:** Users/Auth/Sessions
  (the foundational blocker), Teams, human assignment, private notes,
  mentions, filter-condition evaluator, notification generalization, audit
  log vocabulary extension, global search endpoint, presence, automatic AI
  handoff classification.
- **Phase C — Automation & Intelligence:** Automation rules, conversation
  workflows, macros, live view, reporting-events rollup, CSAT, segments,
  Captain-style suggest/summarize mode, Gemini-based translation.
- **Phase D — Scale & Ecosystem:** Campaigns (with WhatsApp-ban guardrails),
  SLA, help center, AI knowledge sources, Slack/Shopify/Linear/Google
  integrations, webhooks, public API, CSV import, per-agent/team/label
  report breakdowns, CSV export.
- **Phase E — SaaS Platform Operations:** Platform admin console, dashboard
  apps.

Each phase should follow the directive's own pipeline per feature: AUDIT →
GAP MAP → DATA MODEL → DOMAIN SERVICE → API → UI → TEST → REGRESSION. No
phase begins until the prior phase's slices are database-backed,
API-backed, UI-backed, and test-covered — no empty Chatwoot-style menu
items claiming parity ahead of real function.

---

## 6. Final structured report

```
CHATWOOT CAPABILITY MERGER: IN PROGRESS
CHATWOOT FEATURES FOUND: 68
FULLY INTEGRATED: 5
ADAPTED: 23
CURRENTLY MISSING: 38
UNSUPPORTED: 1
DEFERRED: 0
NOT APPLICABLE (tracked separately, not a Chatwoot gap): 2

BETTER THAN REFERENCE:
- CRM-layer customer profile (crm_contacts: stage, lead_status, tags, ai_summary, custom_fields) vs Chatwoot's generic Contact#custom_attributes
- Conversation/message store (whatsapp_messages, AES-256-GCM encrypted at rest) vs Chatwoot's plain Message model
- Message encryption at rest (envelope AES-256-GCM, Redis-cached DEKs) - not a Chatwoot concern at this granularity at all
- Screen-lock PIN with background-service continuity (Argon2id, real lockout, audit log) - no Chatwoot equivalent
- Call metadata capture (real Baileys call-event ingestion) - exceeds Chatwoot's own Twilio-PSTN-scoped Call model for WhatsApp's actual call-event shape

WHATCHATAI-UNIQUE:
- Screen-lock / Application Lock Mode with live background AI+CRM continuity
- AES-256-GCM message encryption at rest
- Lead pipeline as a state on the canonical customer row (no Chatwoot equivalent)
- Planned Google ecosystem integration (Drive/Sheets/Gmail/Calendar/Docs/Slides/Tasks/Chat/Forms/Keep/Meet/Contacts/Picker)
- Gemini-native translation (no separate Translate API dependency)

DATABASE GAPS:
users, business_users/sessions, companies, teams/team_members, labels/conversation_labels,
custom_attribute_definitions, canned_responses, macros, custom_filters, working_hours,
conversation_notes, mentions, automation_rules, workflow_definitions/workflow_instances,
campaigns/campaign_recipients, csat_responses, sla_policies/applied_slas/sla_events,
portals/categories/articles, knowledge_sources/knowledge_documents, handoff_events,
notifications, reporting_events, assignment_policies, agent_capacity_policies,
custom_roles, integration_connections, webhooks, api_tokens, data_imports,
whatsapp_chats extensions (status/priority/snoozed_until/assignee_user_id/assignee_team_id),
whatsapp_contacts.blocked

BACKEND GAPS:
full auth system (login/session/invite/password reset), filter-condition evaluator,
macro action-executor, automation rule executor, campaign send throttling (reusing
existing whatsapp_outbound_messages pipeline), CSAT trigger + inbound-reply capture,
SLA breach-detection sweep job, webhook dispatcher with HMAC-SHA256 signing,
knowledge-document embedding pipeline, notification dispatch generalization,
assignment policy engine (round robin / fair distribution)

API GAPS:
auth endpoints, teams, labels, custom attribute definitions, canned responses, macros,
custom filters, business hours, campaigns, CSAT, SLA, help center, webhooks,
public API token issuance, global search endpoint, notifications, audit log query,
company/contact linkage

UI GAPS:
login/invite/member management, team management, label catalog manager, macro builder,
business hours config, campaign builder, CSAT report view, help center CMS,
notification center, audit log viewer, integration connect screens (Slack/Shopify/
Linear/Google), platform admin console, global search bar, conversation status/
snooze controls, human assignment picker

AI GAPS:
real knowledge-base retrieval (aiContextGathererService's knowledge branch is an
honest stub, not yet backed by real documents), on-demand summarization (ai_summary
column exists, unpopulated), suggest-not-send draft mode for HUMAN_TAKEOVER,
automatic handoff classification, Gemini-based translation

WHATSAPP GAPS:
none beyond the two connector limitations listed below - core messaging, media,
reactions, profile sync, and call-event ingestion are all real and working

AUTOMATION GAPS:
no general trigger-to-action rules engine yet (only the single hardcoded ai_mode
routing primitive exists), no multi-step workflow orchestration layer

REPORTING GAPS:
no historical rollup-event log (dashboard numbers are real but computed live, not
trended over time), no per-agent/team/label/campaign breakdowns, no CSV export

SECURITY GAPS:
no SSO/SAML, audit log event vocabulary currently scoped to screen-lock events only,
no webhook HMAC signing (feature doesn't exist yet), no public API rate limiting
(feature doesn't exist yet)

KNOWN CONNECTOR LIMITATIONS:
Baileys exposes WhatsApp call signaling events but no live call-audio transport -
answering/placing a real WhatsApp call is not implementable with the current
connector, not merely unbuilt;
no WhatsApp Business Platform (Cloud API) template-messaging integration exists -
only personal-account sendMessage - which caps how campaigns can safely be built
without risking a WhatsApp-imposed number ban

FAKE DATA: NONE FOUND
SIMULATIONS: NONE FOUND
PLACEHOLDERS: NONE FOUND
(the one stub-shaped code path found - aiContextGathererService.ts's knowledge-base
branch - is honestly labeled "not yet available" and returns no fabricated content;
this was verified by reading the source, not assumed)

TEST RESULTS: NOT APPLICABLE THIS PASS - no code was changed while producing this
audit (research and documentation only, per the directive's own "MANDATORY CURRENT
TASK" scoping), so no typecheck/unit/integration/security/tenant-isolation run was
required or performed. The existing test suite's status is unchanged from before
this audit began.
```

---

Chatwoot capabilities have been systematically audited against WhatchatAI's
real, current implementation and integrated into a single decision record.
WhatchatAI remains the primary product and source of truth; this document
and its companion matrix are the gap map, not the merger itself — the
merger proceeds one phase at a time from here, starting with Phase A.
