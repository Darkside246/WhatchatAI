# Database Schema

PostgreSQL, versioned migrations in `src/db/migrations/`, applied via
`src/db/migrate.ts` (`npm run db:migrate`). This document reflects the
actual 29 migrations present at the time of writing — regenerate it if
migrations are added rather than trusting it as a permanent source of
truth.

## Table inventory

| # | Migration | Table(s) | Purpose |
|---|---|---|---|
| 001 | `create_businesses.sql` | `businesses` | The tenant root. Every other table scopes to `business_id`, directly or transitively. |
| 002 | `create_whatsapp_accounts.sql` | `whatsapp_accounts` | One row per connected WhatsApp session (a business may have more than one). Profile fields (push_name/profile_picture_url/about_text), real connection_status enum, real sync_status/progress tracking. |
| 003 | `create_whatsapp_contacts.sql` | `whatsapp_contacts` | WhatsApp-native contact identity — verified_name/business_name/push_name/short_name priority chain, presence fields, `source_type`. Unique per (business, account, JID) — JID preserved exactly as WhatsApp sends it. |
| 004 | `create_whatsapp_groups.sql` | `whatsapp_groups` | Group metadata (subject/description/owner/community/announcement flags). |
| 005 | `create_whatsapp_group_members.sql` | `whatsapp_group_members` | Per-group membership, role enum, joined_at/left_at (rows updated in place on rejoin, never duplicated). |
| 006 | `create_whatsapp_chats.sql` | `whatsapp_chats` | The conversation itself — unread_count (real, see below), message_count, ai_mode (added in 026), last_message pointers. |
| 007 | `create_whatsapp_messages.sql` | `whatsapp_messages` | Every persisted message. Unique on `(business_id, whatsapp_account_id, whatsapp_message_id)` — the database itself prevents duplicate WhatsApp messages, not just application logic. Text content is AES-256-GCM encrypted at rest (`EncryptionService`). |
| 008 | `create_whatsapp_message_reactions.sql` | `whatsapp_message_reactions` | **Schema exists, repository exists, but is dead code** — see `docs/reference/architecture-gap-analysis.md`. Reactions currently persist as ordinary `whatsapp_messages` rows instead. |
| 009 | `create_whatsapp_media.sql` | `whatsapp_media` | The real media pipeline's table — download_status/processing_status state machines, sha256, storage_reference, never storage_provider='pending' once actually downloaded. |
| 010 | `add_cross_table_foreign_keys.sql` | (alters `whatsapp_chats`) | Attaches `last_message_id → whatsapp_messages.id` now that the target table exists (migration-ordering constraint, not a design flaw). |
| 011 | `create_whatsapp_presence.sql` | `whatsapp_presence` | **Schema exists, repository exists, but is dead code** — no `presence.update` handler populates it. See gap analysis. |
| 012 | `create_whatsapp_calls.sql` | `whatsapp_calls` | Real call state machine (offer/ringing/accepted/rejected/missed/timeout/ended), `accepted_at` (029) separates ring time from talk time for accurate duration. |
| 013 | `create_whatsapp_statuses.sql` | `whatsapp_statuses` | WhatsApp Status/Stories — text working and real; status *media* is never downloaded (documented, honest gap, not a bug). |
| 014 | `create_whatsapp_connection_events.sql` | `whatsapp_connection_events` | Real connection lifecycle log (connect/disconnect/reconnect attempts, error codes) — confirmed wired to `whatsappConnectionService.ts`. |
| 015 | `create_whatsapp_sync_jobs.sql` | `whatsapp_sync_jobs` | Real sync-job tracking, confirmed wired to `workspaceService.ts`/`whatsappSyncService.ts`. |
| 016 | `create_whatsapp_jid_mappings.sql` | `whatsapp_jid_mappings` | The honest `@lid → phone` mapping table — only populated from Baileys' own `key.remoteJidAlt`, never inferred or fabricated. |
| 017 | `create_plans.sql` | `plans` | SaaS plan definitions. |
| 018 | `create_plan_entitlements.sql` | `plan_entitlements` | What each plan actually allows (e.g. max WhatsApp accounts, max AI agents) — enforced by `EntitlementService`, not just descriptive. |
| 019 | `create_subscriptions.sql` | `subscriptions` | Per-business active plan. |
| 020 | `create_subscription_events.sql` | `subscription_events` | Subscription lifecycle audit trail. |
| 021 | `create_usage_counters.sql` | `usage_counters` | Real usage tracking backing entitlement enforcement. |
| 022 | `create_ai_agents.sql` | `ai_agents` | AI agent configuration records — persona/status; does not yet drive actual Gemini generation (see gap analysis). |
| 023 | `create_crm_contacts.sql` | `crm_contacts` | CRM layer over `whatsapp_contacts` — stage/lead_status/tags (tags real and rendered in the UI). |
| 024 | `create_leads.sql` | `leads` | Lead records. |
| 025 | `seed_plans.sql` | (data only) | Seeds real, not-fake, default plan rows — a data migration, not a schema change. |
| 026 | `add_whatsapp_chats_ai_mode.sql` | (alters `whatsapp_chats`) | Adds `ai_mode` (AI_ACTIVE/AI_PAUSED/HUMAN_TAKEOVER) — real, persisted, editable from the Phase 2 chat header. |
| 027 | `create_security_lock_credentials.sql` | `security_lock_credentials` | Local device-PIN lock (Argon2id hash, client-hashed before the server ever sees it). |
| 028 | `create_security_audit_logs.sql` | `security_audit_logs` | Security event audit trail (Sentinel blocks, lock attempts). |
| 029 | `add_whatsapp_calls_accepted_at.sql` | (alters `whatsapp_calls`) | Adds `accepted_at` so call duration is real talk-time, not ring-time. |

## Confirmed real constraints (not just documented — checked in the actual SQL)

- **Message uniqueness**: `UNIQUE (business_id, whatsapp_account_id, whatsapp_message_id)` on `whatsapp_messages` — the directive's exact requirement, enforced at the database level.
- **JID preservation**: no migration ever transforms a JID string; `chat_jid`/`whatsapp_jid`/`participant_jid` etc. are stored exactly as received. `@lid` identities are a distinct `jid_kind`, never rewritten to `@s.whatsapp.net`.
- **Soft deletes**: every WhatsApp-entity table has `deleted_at`, and identity-uniqueness indexes are partial (`WHERE deleted_at IS NULL`) so a re-paired account/re-added contact never collides with a soft-deleted row.
- **Tenant scoping**: every table below `businesses` carries `business_id`; every WhatsApp-entity table also carries `whatsapp_account_id`. See `docs/database/tenant-model.md`.

## Known gaps vs. the directive's full domain model

`users`/`memberships`/`roles`, `ai_conversations`/`ai_messages`/`ai_jobs`,
`crm_tags`/`crm_notes`/`crm_tasks` (beyond the `tags` array column already
on `crm_contacts`), `automations`/`automation_runs`,
`knowledge_sources`/`knowledge_documents`, `campaigns`/
`campaign_recipients`/`campaign_events` do not exist yet. Per the
directive's own instruction, these are correctly deferred rather than
built now — see `docs/reference/architecture-gap-analysis.md` for the
recommended order.
