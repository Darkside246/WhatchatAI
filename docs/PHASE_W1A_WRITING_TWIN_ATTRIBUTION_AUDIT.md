# Phase W1-A: Writing Twin Attribution Audit

**Status: read-only audit. No tables, migrations, or code changes in this
phase.** This document answers the 15 required questions against the real,
current schema and service code - every claim below is traced to a specific
file, table, or column, not assumed from prior documentation.

---

## 1. Which existing outgoing messages can be reliably attributed to a specific user?

Two channels carry a real `users.id` foreign key on the outgoing row itself;
one channel carries none at all.

| Channel | Attribution column(s) | Reliable? |
|---|---|---|
| Email (`email_messages`) | `created_by UUID REFERENCES users(id)`, `approved_by UUID REFERENCES users(id)`, `drafted_by_agent_id UUID REFERENCES ai_agents(id)` | Partially - see §2 |
| WhatsApp outbound (`whatsapp_outbound_messages`) | `requested_by TEXT DEFAULT 'human'` (values are only the literal strings `'human'` or `'ai'`) | No - see §3 |
| WhatsApp chat assignment (`whatsapp_chats.assignee_user_id`) | Real `users.id` FK, added in migration 037 | Not a message-authorship signal - see §13 |

---

## 2. Email messages: can the system prove the authenticated author?

Yes, with one important caveat. `email_messages` (migration `045_email_messages.sql`):

```sql
created_by UUID REFERENCES users(id) ON DELETE SET NULL,
drafted_by_agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
...
approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
approved_at TIMESTAMPTZ,
```

with a DB-level `CHECK` (`email_approved_has_approver`) that forbids an
`'approved'`/`'sending'`/`'sent'` row from existing without a real
`approved_by`.

**The caveat** (`emailService.ts:337`, `draftWithAi`): when a human asks the
AI to draft an email, `createdBy: requestedBy` is set to the *requesting*
human's id, while `drafted_by_agent_id` is set to the agent. So `created_by`
alone conflates two different things - "who asked for this draft" and "who
authored this text" - and is only proof of human-original authorship when
`drafted_by_agent_id IS NULL`.

A human **can** edit an AI draft before approving it
(`emailService.ts:154`, `updateDraft` - "Only a draft is editable"), but the
repository method (`emailMessageRepository.ts:151`) does a plain
`UPDATE ... SET body_text = $4` with no history retained. **The pre-edit AI
draft text is not recoverable once a human edits it** - there is no
before/after diff captured anywhere in this schema today. This directly
bears on Q4/Q14 below.

**Reliable-attribution rule for email**: `created_by IS NOT NULL AND
drafted_by_agent_id IS NULL` = a genuinely human-authored-from-scratch
email. `approved_by` proves a human reviewed and accepted the final text
(AI-origin or not) but not that they wrote it.

---

## 3. WhatsApp messages: can it prove which team member wrote a human message?

**No.** `whatsapp_outbound_messages` (migration `031_create_whatsapp_outbound_messages.sql`):

```sql
-- No user/auth system exists yet (single-operator dev model) - this
-- documents that only a human-initiated API call may ever create a row
-- here. Nothing in this phase gives the AI layer a path to this table.
requested_by TEXT NOT NULL DEFAULT 'human',
```

That comment is stale - real authentication (`users`, `business_memberships`,
sessions) was added later (migration 035) - but no later migration ever
added a `user_id` column to this table (confirmed: `grep` across every
migration referencing `whatsapp_outbound_messages` - 031, 038, 046, 049 -
shows only `message_type`/`status` constraint widenings and new columns for
voice notes and indeterminate-send reconciliation, never a user FK).

**Important finding, not previously documented**: the send route itself
(`server/index.ts:790`, `POST /api/workspace/chats/:chatId/messages`) *does*
already run behind session authentication - `res.locals.auth.userId` (a real
`users.id`, see `authMiddleware.ts:9`'s `AuthContext`) is available at that
exact point in the request lifecycle. The route simply never reads it when
calling `whatsappOutboundMessageService.send()` - only
`res.locals.workspaceContext.businessId`/`whatsappAccountId` are threaded
through. **The identity is already authenticated and available; it is just
not persisted.** This makes closing the gap a cheap, additive column +
one-parameter change in a future W2/W3 phase, not a redesign - but it is
still a genuine gap today, and W1-A must report it as one, not assume it
away.

Every WhatsApp send today is therefore only ever `'human'` or `'ai'` at the
schema level - never resolvable to a specific team member.

---

## 4. Which corrections to AI drafts can be captured reliably?

**None, today, anywhere.** Confirmed by direct inspection of every
AI-drafts-then-human-edits path in the codebase:

- Email: `updateDraft` overwrites `body_text` in place (§2) - no diff, no
  "original AI text" column, no correction record.
- WhatsApp: there is no AI-draft-then-edit flow at all. `aiReplyService.ts`
  generates a reply and it is sent directly (or escalated to human takeover)
  - there is no intermediate "AI proposed, human edited before send" state
  machine on the WhatsApp side (unlike email's `draft` status).

**This is the single largest gap for W4 (Correction Learning)**: the
highest-quality training signal a Writing Twin could have - "the AI wrote
X, the human changed it to Y" - does not exist in any recoverable form in
this codebase today. W2's schema work must capture this going forward (e.g.
retain the pre-edit text as a first-class column or row, not overwrite it);
it cannot be backfilled from history that was never kept.

---

## 5. Which channels already contain enough metadata for learning?

Ranked by current reliability:

1. **Email, human-authored-from-scratch** (`created_by` set,
   `drafted_by_agent_id IS NULL`, `status = 'sent'`) - real, unambiguous,
   single-author, already timestamped and business-scoped. The strongest
   available bootstrap signal today.
2. **Email, human-edited-then-approved AI draft** - the *final* sent text is
   real and human-approved, but (per §4) it cannot be distinguished from an
   unedited AI draft the human merely approved without changing a word. Both
   look identical in the schema: `drafted_by_agent_id` set, `approved_by`
   set. Unsafe to treat as a style example without W2 adding a real
   diff/edit-detection mechanism.
3. **WhatsApp outbound, human-sent** - real, but unattributable to a specific
   user (§3) and, in a shared inbox, potentially typed by any team member
   with `whatsapp.send` permission on that business. Cannot be safely used
   for per-user learning until attribution exists (W5's own stated
   precondition, and this audit's finding independently confirms it).
4. **Campaigns** - checked (`campaigns`/`campaign_recipients`, migration
   038): campaign body text is a single business-level template, not
   per-conversation, per-customer prose in anyone's individual voice. Not a
   style-learning candidate at all, for any user.

---

## 6. Where exactly would writing-style context enter the existing AI pipeline?

Identical insertion point to D4-B's document context, by design (this
codebase's own established pattern, now used three times: knowledge base,
business documents, and - proposed here - writing style):

`aiContextGathererService.ts`'s existing `Promise.all` inside
`gatherAiHandoffContext` (already gathers `crmContact`, `knowledgeBase`,
`documentContext`, `conversationHistory`, `business`, `media` concurrently).
A future `writingStyleContext` branch would slot in the same way,
called with `(businessId, userId-or-agentId)` rather than a search query -
since style retrieval is "the profile for the person/agent replying," not a
free-text search.

**Important distinction from documents/KB**: those are *retrieved as
untrusted reference data* via `wrapUntrustedData()`. Writing style is
different in kind - it should shape *how* the model writes (tone, phrasing,
sentence length), not be presented as a quoted fact the model might cite.
W1-B must design this as **prompt-instruction content** ("Match this
person's writing style: ...") assembled by trusted, code-owned logic from
structured/aggregated style signals - never as raw pasted excerpts of a
user's private messages wrapped in `<untrusted_data>` the way a CRM note is.
Feeding a user's actual raw sent messages into the prompt verbatim would
leak conversational content (potentially containing customer PII) into a
different customer's reply context. This is a hard design constraint for
W6, not just a stylistic preference.

---

## 7. How do we guarantee customer messages are never accidentally used as training signals?

No existing table in this codebase currently distinguishes "message I sent"
from "message I received" via a column safe to filter on in isolation - but
every outbound-authorship table already *is* the correct filter, by
construction: `email_messages` only contains messages a business sent (no
inbound customer email exists in this schema at all - there is no email
ingestion), and `whatsapp_outbound_messages` only contains dispatch attempts
this business initiated (`whatsapp_messages.direction = 'inbound'` rows are
a completely separate table/path and would never be queried by a Writing
Twin data source).

**The rule this audit recommends** (matching the user's proposed
requirement verbatim): any W2 learning-source query must be structurally
restricted to tables/columns that are *definitionally* outbound-only
(`email_messages`, `whatsapp_outbound_messages`) - never `whatsapp_messages`
filtered by a `direction` or `from_me` condition applied at the application
layer, which is exactly the kind of caller-discretion-dependent filter this
engagement's own D3-A audit already proved is fragile (the soft-delete
chunk-survival finding). The structural table boundary, not a WHERE clause
a future caller could forget, is what must carry this guarantee.

---

## 8. How do we enforce `business_id + user_id` as a hard wall?

This codebase's own proven pattern (used everywhere since Phase 0.1's
`findByIdForBusiness` convention, and D3-C's SQL-join-enforced tenant
boundary) is directly reusable: every Writing Twin repository method must
take `(businessId, userId, ...)` and bake both into the `WHERE` clause of
its own query, never rely on a caller having already filtered. Given
§13's shared-inbox risk, this pair is necessary but **not sufficient** on
its own for message-level sources - see §13.

---

## 9. How does a user disable learning?

No existing per-user opt-in/opt-out flag exists in this codebase to model
this on directly, but `user_preferences` (migration `035_create_auth_foundation.sql:78`,
`user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`) is the
established, proven shape for "one row per user, owned by that user, gone
when the user is." A future W2 table (e.g. `writing_twin_settings` or a
column on a new `writing_twin_profiles` table) modeled the same way -
one row per user, a `learning_enabled BOOLEAN NOT NULL DEFAULT false`
column, fail-closed by default matching D1's `ai_retrievable` precedent -
is the natural fit. **Recommendation for W1-B**: default OFF, not opt-out -
matching this engagement's consistent "narrow now, widen later" and
fail-closed defaults (D1's four capability flags, all default `false`).

---

## 10. What happens to already-collected data when learning is disabled?

Not yet designed - correctly out of scope for W1-A - but the audit surfaces
the real design fork W1-B must resolve explicitly: does disabling learning
(a) stop new collection but keep the existing profile/examples, or (b)
purge them immediately? No precedent in this codebase answers this by
itself (no existing feature has a "collected personal data, user can turn
off" lifecycle to copy). W1-B should propose one, not both, with a stated
default - most consistent with the user's own stated hard rule (data must
be demonstrably authorized) is that disabling learning stops new collection
but does not retroactively delete already-approved-for-use profile data
unless the user separately requests deletion (§11) - i.e. "stop" and
"erase" are two distinct actions, not one toggle.

---

## 11. How is the Writing Twin deleted?

No existing account/user-data deletion flow exists anywhere in this
codebase to model this on (confirmed: no purge/GDPR/erasure code path
found in a repository-wide search). This is a genuine gap, not unique to
the Writing Twin - W1-B should scope "delete this user's Writing Twin data"
narrowly (a documented, callable deletion path, e.g. a settings action
that `DELETE`s or truncates the user's own profile rows scoped by
`business_id + user_id`) rather than attempting to design a
full account-deletion system as a side effect of this feature.

---

## 12. How is retention handled?

Same finding as §11: no existing retention/expiry precedent in this
codebase (no TTL columns, no scheduled purge jobs for personal data
anywhere in `src/queue/workers/`). W1-B needs to decide this fresh. Given
the user's own stated hard rule about authorized-only data, a defensible
default to propose in W1-B: retain learning examples indefinitely while
`learning_enabled = true` (matching how CRM notes/conversation history are
retained indefinitely today - this codebase's existing norm), but this is
a product/legal decision, not a technical one this audit should decide
unilaterally.

---

## 13. How do we prevent a shared team inbox from contaminating one user's style profile?

This is the sharpest real risk this audit found, concretely:

- `whatsapp_chats.assignee_user_id` (migration 037) records who a
  *conversation* is assigned to - **not** who typed any individual message
  in it. Any team member with `whatsapp.send` permission on the business
  can send from any chat regardless of `assignee_user_id` (confirmed: the
  send route's permission check is `requirePermission('whatsapp.send')`,
  a business-level permission, not scoped to "only the assignee").
- Therefore `assignee_user_id` **must never be used as a proxy for message
  authorship** - it would silently attribute a covering colleague's or a
  shared-inbox teammate's actual words to the assigned user's style
  profile. This is exactly the contamination risk the user's proposed rule
  is meant to prevent.
- Combined with §3's finding (no `user_id` on `whatsapp_outbound_messages`
  at all today), **WhatsApp cannot safely be a Writing Twin learning source
  until both gaps are closed**: (a) a real per-send `user_id` column
  (populated from the already-available `res.locals.auth.userId`, per §3),
  and (b) confirmation at write-time that no other user could have sent
  through that same session/credential. This is precisely why W5 is
  correctly sequenced last, after per-user attribution exists, in the
  user's proposed phase order - this audit's evidence supports that
  sequencing decision directly rather than merely restating it.

Email has no equivalent shared-inbox risk today: `created_by`/`approved_by`
are always the specific authenticated user who took that action, since
email drafting/approval routes are already individually authenticated
(no shared "send as business" credential exists for email the way a shared
WhatsApp business number is inherently shared).

---

## 14. How do corrections receive higher confidence than passive examples?

No existing confidence/weighting concept exists anywhere in this codebase's
AI pipeline to reuse (agent configuration is static persona/tone text, not
weighted examples). This is new design surface for W1-B/W3/W4, not
something this audit can resolve from precedent. The one concrete
prerequisite this audit does establish: **corrections cannot be weighted
higher than passive examples until they can be captured at all** - and per
§4, they currently cannot be, for any channel. W2's schema must add explicit
before/after correction capture (not overwrite-in-place, as email currently
does) before W4 has anything to weight.

---

## 15. How do we bootstrap a new user with insufficient examples?

Not decided by this audit - a product/UX question for W1-B - but the audit
notes the honest current state: with zero human-authored-from-scratch
emails and no WhatsApp attribution, a brand-new user has **no** learning
signal at all on day one under the current schema. W1-B should propose a
graceful degradation (e.g. fall back to the agent's own configured
tone/persona, exactly as today, until N examples exist) rather than a
partial or fabricated style profile - consistent with this engagement's
consistent fail-closed/never-fabricate discipline (documented and search
services never return a fabricated result on failure; the Writing Twin
should never claim to have learned a style it has not).

---

## Summary table

| Question | Answer |
|---|---|
| 1. Attributable channels | Email (partially), WhatsApp (no) |
| 2. Email authorship provable | Yes, except AI-drafted-then-edited text (edit overwrites, unrecoverable) |
| 3. WhatsApp per-user provable | No column exists; the authenticated identity is available at the route but never persisted |
| 4. Corrections capturable today | None - no channel retains a pre-edit/AI-original value |
| 5. Best bootstrap source | Human-authored-from-scratch email |
| 6. Pipeline insertion point | Same `Promise.all` in `gatherAiHandoffContext` as documents/KB, but as instruction content, never `wrapUntrustedData`-style quoted excerpts |
| 7. Customer-message exclusion | Structural table boundary (outbound-only tables), not an application-layer WHERE filter |
| 8. business_id+user_id wall | Reuse the proven `findByIdForBusiness`/D3-C SQL-join convention |
| 9. Disable learning | New per-user settings row, modeled on `user_preferences`, default OFF |
| 10. Data after disabling | Design fork for W1-B; recommend stop-collecting ≠ auto-delete |
| 11. Deletion | No existing precedent; W1-B must design a narrow, scoped deletion path |
| 12. Retention | No existing precedent; propose indefinite-while-enabled, pending product decision |
| 13. Shared-inbox contamination | Real, concrete risk confirmed - `assignee_user_id` is not authorship proof; WhatsApp unsafe as a source until attribution exists |
| 14. Correction confidence | Cannot be designed until capture exists (§4); new surface for W3/W4 |
| 15. New-user bootstrap | Fall back to existing agent persona/tone; never fabricate a profile |

---

## Recommended formal requirements (for W1-B to carry forward)

Both of the user's proposed rules are adopted as-is, since nothing in this
audit's findings conflicts with either and both directly address concrete
gaps this audit found (§4, §7, §13):

> The Writing Twin may learn only from content demonstrably authored,
> edited, or explicitly approved by the authenticated user. Customer-
> authored content, inbound messages, and content from another employee
> must never become style-learning data. If authorship cannot be proven,
> the content must be excluded by default.

> The Writing Twin is personal to the user within the business. No other
> user in the same business may access, use, inherit, or influence another
> user's Writing Twin unless a future feature explicitly creates a
> separately authorised shared business style profile.

---

## What W1-B must resolve

1. The exact schema shape for capturing corrections (before/after, not
   overwrite) - required before W2/W4 can do anything.
2. Whether/how to close the WhatsApp attribution gap (§3) - add a real
   `user_id` column to `whatsapp_outbound_messages`, populated from the
   already-available `res.locals.auth.userId` - as an explicit, separate,
   additive migration, before W5 can begin at all.
3. The learning-disabled data lifecycle (§10) and deletion path (§11).
4. The prompt-insertion design for style context as instruction content,
   not `wrapUntrustedData` quoted excerpts (§6).
5. A concrete definition of "insufficient examples" and the bootstrap
   fallback behavior (§15).

No code, schema, or migration changes were made in this phase.
