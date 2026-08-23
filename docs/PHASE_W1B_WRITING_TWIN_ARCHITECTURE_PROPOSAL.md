# Phase W1-B: Personal AI Writing Twin — Architecture Proposal

**Status: design only. No tables, migrations, dependencies, or code in this
phase.** Builds directly on W1-A's audit findings
(`docs/PHASE_W1A_WRITING_TWIN_ATTRIBUTION_AUDIT.md`) and this engagement's
established conventions (D1's fail-closed capability flags, D3-C's
structural SQL-enforced tenant boundary, D4-B's `Promise.all`
context-gathering insertion point). Every design decision below either
reuses a proven pattern from this codebase or explicitly states why it
cannot.

---

## 1. Threat model

| Actor | Capability | What must be prevented |
|---|---|---|
| A customer messaging the business | Fully untrusted; can phrase anything, including prompt-injection-shaped text | Their words must never enter another person's - the business user's - Writing Twin as if the business user wrote them |
| A malicious or careless business user | Authenticated, holds real permissions | Cannot read, trigger, or influence another user's Writing Twin, even within the same business |
| A compromised/buggy integration or future feature | Could write to a shared table | Must not be able to silently attribute its output to a human user's style profile (mirrors D1/D3's data-access-layer defense-in-depth principle) |
| The AI model itself (Gemini) | Generates text, sees prompt content | Must never be granted a tool or code path that reads/writes Writing Twin data directly - retrieval into its context is the only channel, exactly like D4-B's document retrieval boundary |
| A future engineer extending this codebase | Could write a new, unscoped query against Writing Twin tables | The schema/repository layer must make an unscoped or cross-user query structurally awkward to write correctly by accident - narrow, dedicated methods, not one generic one (D3-C's Option A precedent) |
| Someone with direct DB access investigating an incident | Needs to audit what was learned and why | Every learning event must be traceable to a specific provenance classification and source message, not an opaque blob |

The single highest-value asset here is not "a table of text" - it is **a
specific person's private authorial voice**, which is more sensitive than a
CRM note or a business document because it is about the user, not a
business record the user chose to write for the business. This changes the
posture from D1-D4's "business data, isolated per-tenant" to "personal
data, isolated per-tenant *and* per-person, opt-in, deletable."

---

## 2. Data classification

Three tiers, matching the user's required A/B/C separation, each with a
distinct sensitivity level and lifecycle:

| Tier | Contents | Sensitivity | Default retention posture |
|---|---|---|---|
| **A. Writing memory** | Derived, aggregated signals (sentence-length distribution, formality score, common sign-offs, punctuation habits, etc.) - never verbatim source text | Low-moderate - a statistical fingerprint, not the source material itself | Long-lived while learning is enabled; survives a raw-event purge |
| **B. Style examples** | A small, bounded, explicitly-eligible set of real sentences/messages kept verbatim to demonstrate style to the model | Moderate-high - verbatim personal text, but curated and capped | Long-lived, but capped in count and subject to periodic review/rotation |
| **C. Raw learning events** | The full source material (a sent message, an AI-draft/final-edit pair) used *temporarily* to extract A and B | High - a growing archive of everything processed would itself become a liability | Short-lived by design - processed then eligible for deletion, never an unlimited permanent archive (the user's explicit concern) |

This tiering is the load-bearing design decision of the whole proposal:
**Tier C existing is not the same as Tier C being retained.** A/B are
*derived from* C, but their retention is intentionally decoupled from C's -
deleting C does not have to delete A/B (the derived signal can outlive its
raw source, the same way an aggregate statistic outlives the individual
data points once computed), and disabling learning does not have to purge
A/B immediately (§7).

---

## 3. Ownership and tenant isolation

Every Writing Twin table, at every tier, carries both `business_id` and
`user_id` as required columns - never one without the other, and never a
table where either could be null for a real row. This directly implements
the user's Rule 1.

**Enforcement mechanism** (reusing D3-C's proven approach rather than
inventing a new one): a private, shared query-building method per
repository, exposed only through narrow, purpose-named public methods
(`getStyleProfileForUser(businessId, userId)`,
`recordApprovedExample(businessId, userId, ...)`, never a generic
`find(...)` that a future caller could misuse to omit the `user_id`
predicate). Every method's SQL `WHERE` clause includes
`business_id = $1 AND user_id = $2` structurally, exactly like D3-C's
`business_id`/`deleted_at`/`status`/`ai_retrievable` join - the boundary
lives in the query itself, not in caller discipline.

**Where `userId` originates**: exclusively `res.locals.auth.userId` (the
real `AuthContext.userId`, W1-A §3's own finding that this value is already
authenticated and available server-side at every relevant route). It is
never accepted as a request body/query parameter, never derived from AI
output, never inferred from a chat's `assignee_user_id` (W1-A §13's
explicit warning against exactly that substitution), and never passed
through from a tool-call argument. The same "server-controlled identity,
never AI/customer-influenced" principle D4-A proved for `businessId` applies
identically to `userId` here.

**Cross-business and cross-user access are the same class of bug**, and
both must be prevented the same way: structurally, in SQL, not by
route-level trust. A Writing Twin lookup for `(businessId=A, userId=U)`
must be indistinguishable in behavior from "no profile exists" when
queried as `(businessId=B, userId=U)` or `(businessId=A, userId=V)` - same
honest-empty-result discipline this codebase already applies everywhere
(`knowledgeBaseSearchService`, `documentSearchService`,
`aiDocumentRetrievalService`).

---

## 4. Attribution/provenance model

W1-A's central finding was that today's schema conflates "who requested
this" with "who wrote this." The Writing Twin must never repeat that
mistake. Every piece of source material considered for learning is
classified into exactly one of five provenance states before it is ever
touched by any extraction logic:

| Provenance | Definition | Learning eligibility |
|---|---|---|
| `human_authored` | The authenticated user wrote this text themselves, with no AI involvement in its generation (`drafted_by_agent_id IS NULL` for email; a future WhatsApp equivalent once W5 attribution exists) | Eligible - highest baseline confidence |
| `ai_generated_unchanged` | An AI agent drafted this, and the user sent/approved it with zero edits | **Not directly a style example** - it reflects the AI's phrasing, not the user's. May inform "the user approves of this tone" as a weak signal, never a style source (§9) |
| `ai_generated_then_edited` | An AI agent drafted this, and the user materially changed it before sending/approving | Highest-value signal (§12, correction learning) - but only the *diff*/edit pattern is eligible, and only once W2 actually captures the pre-edit baseline (it does not exist today, per W1-A §4) |
| `explicitly_approved` | The user took a deliberate UI action confirming "this represents how I write" (see §9 - distinct from merely not editing a draft) | Eligible, at a confidence tier below `human_authored` |
| `unknown_or_ambiguous` | Provenance cannot be established from the source data with confidence (e.g. `assignee_user_id` without a real per-send `user_id`, or any WhatsApp message before W5) | **Never eligible. Fails closed by construction** - excluded at the query layer, the same structural-exclusion discipline as D3-C's `ai_retrievable` predicate, not a downstream filter a caller could forget |

This directly satisfies Rule 2: `created_by` being set, a user requesting
an AI draft, chat assignment, and same-business origin are each explicitly
listed above as **insufficient** on their own - only `human_authored`,
`ai_generated_then_edited` (post-W2), and `explicitly_approved` ever reach
the learning pipeline.

---

## 5. Learning eligibility rules

A message/draft becomes eligible for any learning tier only when **all**
of the following hold simultaneously:

1. `provenance IN ('human_authored', 'ai_generated_then_edited', 'explicitly_approved')` (§4).
2. `business_id` and `user_id` match the authenticated context that will
   consume it - no cross-user aggregation, ever (§3).
3. `learning_enabled = true` for that user at the time of *collection*
   (not retroactively re-evaluated - see §6 for what changes when this
   flips).
4. The content is definitionally outbound-only, sourced from a table that
   cannot contain inbound customer text by construction (W1-A §7's
   structural-boundary rule - never an application-layer
   direction/from-me filter).
5. For channel-scoped learning specifically: WhatsApp-sourced examples are
   additionally gated on W5's attribution migration existing at all (§13,
   §18) - this gate is unconditional and cannot be bypassed by any
   per-message signal, since no per-message WhatsApp signal is trustworthy
   until then.

Any message failing any one of these is simply never considered - not
stored in Tier C with a "rejected" flag, not logged for later reconsideration
unless the underlying condition itself changes (e.g. W5 shipping). This
keeps rule 4 from becoming a partial, error-prone allowlist evaluated per
record; it is a structural precondition on which sources are ever queried
at all.

---

## 6. ON/OFF lifecycle

Modeled on `user_preferences`' proven one-row-per-user shape
(`user_id PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`), a
`writing_twin_settings` row (conceptual - no migration in this phase) per
`(business_id, user_id)` pair, default `learning_enabled = false`
(fail-closed, matching D1's four capability flags' default-`false`
precedent).

States and transitions:

- **OFF → ON**: collection begins going forward. Per the user's explicit
  instruction, **historical backfill is a separate, explicit opt-in
  action** - turning learning on does not retroactively scan existing
  historical email/WhatsApp history. A distinct UI action ("Learn from my
  history") is required to trigger a one-time backfill job, itself subject
  to the same eligibility rules in §5.
- **ON → OFF (pause)**: stops new Tier C collection *immediately* - not
  "at the next scheduled job," a live flag check at the collection point
  itself. Per the user's recommendation: **existing Tier A (writing
  memory) and Tier B (style examples) remain available and continue to be
  used for generation** - pausing is not the same as deleting. This
  matches §2's decoupled-retention design: A/B outlive a stop in
  collection.
- **OFF → ON again**: resumes collection; does not replay or reprocess
  anything from the paused period (no message is "backfilled" merely by
  learning being re-enabled - that would violate the explicit-opt-in
  backfill rule above).
- **Full deletion** (§7): a distinct, separate action from OFF - removes
  all three tiers.

---

## 7. Deletion and retention

Adopting the user's recommendation directly, made concrete per tier:

| Tier | On "pause" (learning OFF) | On explicit "Delete Writing Twin" |
|---|---|---|
| A. Writing memory | Retained, continues to be used | Deleted |
| B. Style examples | Retained, continues to be used | Deleted |
| C. Raw learning events | Collection stops; already-collected rows are unaffected by pause alone | Deleted |

**Default retention without any user action**:
- Tier C (raw events) gets a **short, bounded retention window** by
  default (a concrete number - e.g. 30-90 days - is an open decision for
  W2, §21) after which it is deleted by a scheduled sweep, regardless of
  whether the user ever explicitly deletes anything. This is the
  structural answer to the user's stated concern about an "unlimited
  permanent archive of everything a user has ever written" - the archive
  is bounded by construction, not by hoping a purge job never gets
  skipped. Once a raw event has been processed into Tier A/B (or
  determined not to yield a usable signal), it has no further reason to
  exist.
- Tier A/B have no default expiry - they are small, derived/curated, and
  their entire purpose is to persist as the user's ongoing profile. Tier B
  is additionally **count-capped** (§10), which bounds its size
  independently of time.

**Deletion is a real, callable, narrowly-scoped action** (a settings-page
button in the eventual UI, backed by a service method deleting exactly
`WHERE business_id = $1 AND user_id = $2` across all three tiers in one
transaction) - not a side effect of any other feature, matching W1-A §11's
finding that no account-deletion precedent exists to lean on; this phase
builds the narrow version this specific feature needs, nothing broader.

**Reset** (distinct from delete): clears Tier A and B (the learned
profile) while leaving `learning_enabled` as the user set it - "start over
learning my style" without also toggling the setting off. Tier C's
existing rows are unaffected by a profile reset (they were already going
to expire on their own schedule, and a reset does not need to force early
deletion of material that might still be mid-processing).

---

## 8. Profile architecture

Conceptual (non-binding on final column names/types - that is W2's job)
shape, one row set per `(business_id, user_id)`:

```
writing_twin_settings        (1 row per user)
  business_id, user_id (PK pair)
  learning_enabled BOOLEAN DEFAULT false
  historical_backfill_completed_at TIMESTAMPTZ NULL
  created_at, updated_at

writing_twin_profiles        (Tier A - "writing memory")
  business_id, user_id, channel_scope ('global'|'email'|'whatsapp')
  aggregate signals (see §9) - structured columns or a constrained JSON shape
  example_count, last_recomputed_at
  UNIQUE (business_id, user_id, channel_scope)

writing_twin_style_examples  (Tier B - bounded curated examples)
  id, business_id, user_id, channel_scope
  source_provenance ('human_authored'|'ai_generated_then_edited'|'explicitly_approved')
  example_text (bounded length)
  added_at
  -- capped in COUNT per (business_id, user_id, channel_scope), see §10

writing_twin_raw_events      (Tier C - short-lived source material)
  id, business_id, user_id, channel_scope
  provenance, source_table, source_row_id (a reference, not a duplicate copy where avoidable)
  ai_baseline_text NULLABLE, final_text
  processed_at NULLABLE, expires_at NOT NULL
```

`channel_scope` is a first-class column, not a separate table per channel
(matching this codebase's existing preference - one `business_documents`
table with a `mime_family` distinction, not per-type tables) - simpler to
query with a fallback hierarchy (§13) and consistent with how
`ai_agents.category` already differentiates agent types in one table.

---

## 9. Aggregate style signals (Tier A)

Structured, bounded signals only - never a verbatim transcript. Candidate
signal categories, directly from the user's list:

- Sentence length distribution (mean/median, not every sentence)
- Formality register (a bounded score/category, not free text)
- Common greetings/sign-offs (a small top-N list, capped)
- Punctuation habits (e.g. frequency of exclamation points, ellipses)
- Emoji usage rate and a small top-N set actually used
- Common phrases (a bounded, deduplicated top-N list - never a raw
  n-gram dump of everything the user has said)
- Directness/hedging tendency (a bounded score)
- Question-asking pattern
- Spelling/regional habits (e.g. "color" vs "colour") if detectable
  from a bounded sample
- Response structure (e.g. typical opening/body/closing shape)

**Every signal here is either a number, a bounded category, or a small
capped list - never an unbounded field.** This is deliberate: Tier A must
be safely includable in a prompt without its own length-bounding logic
being load-bearing the way Tier B's is, and it must be safe to log/inspect
for debugging without re-exposing large amounts of verbatim personal text.

Recomputation: a scheduled or triggered job re-derives Tier A from
currently-eligible Tier B examples (and unprocessed-but-still-live Tier C
events) - Tier A is a *view* over B/C's signal, conceptually recomputable
from scratch at any time, not an append-only ledger of its own.

---

## 10. Bounded style examples (Tier B)

- **Hard cap per `(business_id, user_id, channel_scope)`** - a concrete
  number is a W2 decision (e.g. 20-50), but the architectural requirement
  is that it is enforced the same way D1 enforced `max_business_documents`
  (an `EntitlementService`-style count check before insert, matching that
  proven pattern rather than an unbounded table with only a "please don't"
  comment).
- Provenance-eligible only (§4/§5) - never an AI-generated-unchanged
  example, per §4's table.
- Length-bounded per example (mirrors `SNIPPET_LENGTH`/`MAX_CHUNK_CHARS`
  precedent from `knowledgeBaseSearchService.ts`/`aiDocumentRetrievalService.ts`).
- When the cap is reached, a rotation policy is needed (evict oldest?
  lowest-confidence? - an open decision, §21) rather than silently
  rejecting new, possibly better examples forever.
- **`explicitly_approved` provenance requires a real, distinct user
  action** - not merely "the user did not edit this draft before sending."
  W1-A explicitly found that an unedited-and-approved AI draft is
  indistinguishable in today's schema from an edited one; W1-B's design
  requires the *approval-as-a-style-example* action to be its own,
  separate, deliberate step (e.g. a "use this as a style example" control
  distinct from the ordinary send/approve action) - never inferred from
  ordinary approval alone, which the user's Rule 2 explicitly rules out.

---

## 11. Raw event lifecycle (Tier C)

1. **Collection**: a source event (a sent human-authored message, an
   AI-draft/final-edit pair) that passes §5's eligibility gate is written
   as one `writing_twin_raw_events` row, with a computed `expires_at` set
   at insert time (never computed later, so the deletion sweep never
   depends on a row having been "seen" again after creation).
2. **Processing**: an asynchronous job (matching this codebase's
   established BullMQ-worker pattern, e.g. `documentParseWorker`'s shape -
   though this is new-worker design, explicitly deferred to W3, not
   proposed as part of W1-B) extracts Tier A signal updates and candidate
   Tier B examples from the raw event, then marks it `processed_at`.
3. **Expiry**: a scheduled sweep (matching the existing "stale job sweep"
   pattern already used for outbound-message/sync-job/call-timeout
   reconciliation) deletes any row past `expires_at`, processed or not -
   an unprocessed row that ages out is simply never used, not force-processed
   to avoid losing it. This keeps the bound real: nothing about a slow
   processing pipeline can make Tier C grow without limit.
4. **No raw event is ever included in an AI prompt directly** - only
   Tier A/B ever reach `gatherAiHandoffContext` (§15). Tier C exists solely
   as short-lived input to the extraction step.

---

## 12. Correction-diff architecture

Directly addressing W1-A §4's finding that this data does not exist today
because email's `updateDraft` overwrites in place:

**W2 must change the write path** (not part of this design-only phase, but
specified here as a hard requirement for W2): when a draft is edited before
approval/send, the system must capture **both** the pre-edit AI baseline
and the final approved text as two values of one correction record -
either by no longer allowing silent overwrite (retaining the original
until send) or by snapshotting the pre-edit value into a
`writing_twin_raw_events` row (`ai_baseline_text` + `final_text`, per §8's
conceptual shape) at the moment of the first edit. This is an explicit,
scoped change to existing email-draft-editing behavior that W2 must design
concretely - **W1-B does not implement it**, it only establishes that it
is a hard prerequisite, not an assumption that correction data already
exists anywhere.

From a captured `(ai_baseline_text, final_text)` pair, a **bounded derived
correction signal** is computed (e.g. "tends to shorten AI drafts by ~20%,"
"consistently removes exclamation points," "adds a personal sign-off the
AI omitted") - never the raw diff stored as an unbounded, ever-growing
list. This is Tier A material, derived exactly like any other aggregate
signal, just from a higher-confidence source. The `(ai_baseline_text,
final_text)` pair itself lives in Tier C and is subject to Tier C's normal
expiry - it is not exempted into permanent storage merely because it is
high-value; only its *derived signal* persists.

---

## 13. Channel-specific profiles

`channel_scope IN ('global', 'email', 'whatsapp')` (§8). Retrieval fallback
hierarchy, exactly as the user specified: **channel-specific profile →
global profile → no style context** (never a hard failure - matches this
codebase's universal fail-closed-to-"no context," never fail-closed-to-error,
discipline).

`global` is not a fourth independent profile collected separately - it is
the union/aggregate across all channels the user has eligible signal for,
recomputed the same way any Tier A signal is (§9). A user with only email
signal has a `global` profile derived entirely from email; once WhatsApp
signal exists (post-W5), `global` begins incorporating it too, without a
schema change.

**WhatsApp's `channel_scope = 'whatsapp'` row structurally cannot be
populated before W5 ships**, because §5's eligibility rule (condition 5)
makes this an unconditional gate, not a per-message check that could be
individually satisfied earlier. This is stated here as a hard requirement
this proposal will not relax, matching the user's explicit instruction that
this audit finding "should not be bypassed."

---

## 14. Confidence scoring

Every Tier A signal and Tier B example carries an implicit or explicit
confidence tier derived from its source provenance (§4), not a separately
invented number:

| Provenance | Relative confidence |
|---|---|
| `ai_generated_then_edited` (correction signal) | Highest - proven to reflect a deliberate choice to change AI-authored text into the user's own preferred version |
| `human_authored` | High - written from scratch by the user |
| `explicitly_approved` | Moderate - the user endorsed it, but did not necessarily originate every word |
| `ai_generated_unchanged` | Not used as a style signal at all (§4) |
| `unknown_or_ambiguous` | Excluded entirely, not merely down-weighted (§4/§5) |

Confidence is not a machine-learned score in V1 (§5 of the user's message:
"start with retrieval and structured style signals, not fine-tuning") - it
is this fixed, provenance-derived ranking, used to (a) prioritize which
Tier B examples are kept when the cap (§10) is reached, and (b) weight
which Tier A signals are surfaced first if a future UI needs to summarize
"what has the Writing Twin learned."

---

## 15. Retrieval into `gatherAiHandoffContext`

Reuses D4-B's exact insertion shape - one more branch inside the existing
`Promise.all` in `aiContextGathererService.ts`'s `gatherAiHandoffContext`:

```
retrieveWritingTwinContext(businessId, userId, channelScope)
```

Called with:
- `businessId` - the same server-derived value already used for every
  other branch.
- `userId` - **the id of the human user on whose behalf this reply is
  being generated** (not the customer, not the AI agent). This is a new
  question this feature raises that documents/KB did not: WhatsApp AI
  replies today are generated by an *agent* (`ai_agents`), not on behalf
  of a specific team member. **Open design question for W6** (§21):
  whose Writing Twin applies to an AI-agent-generated reply, if any? The
  architecturally safe default is that the Writing Twin only applies when
  a specific authenticated user's own style is what's being invoked (e.g.
  a "draft in my voice" feature), not as a blanket influence on every
  autonomous AI agent reply - conflating the two would violate Rule 2's
  human-authored provenance requirement, since an agent's reply was never
  authored by that user in the first place.
- `channelScope` - `'email'` or `'whatsapp'`, resolved from the calling
  context (which channel this reply is for), with the fallback hierarchy
  (§13) applied inside the service, not the caller.

Returns the same honest `{available, results/profile, reason}`-shaped
contract as `knowledgeBase`/`documentContext` - `available: false` on any
real failure, `available: true` with an honestly-empty profile when the
user has no eligible signal yet (never fabricated), exactly matching
`aiDocumentRetrievalService.ts`'s existing fail-closed contract.

---

## 16. Exact trusted-context handling

This is the one place this design **deliberately departs** from the
`wrapUntrustedData()` pattern used for documents/KB/CRM notes, per W1-A
§6's finding, restated and made binding here:

- Tier A (writing memory) is **trusted, code-assembled instruction
  content** - e.g. `buildSystemInstruction` (or its future
  writing-twin-aware extension) renders it as prose like `"Match this
  person's writing style: tends toward short sentences, informal tone,
  signs off with 'Thanks!', rarely uses exclamation points."` This is
  synthesized by trusted code from structured signals, not user-authored
  free text being echoed - so it does not carry prompt-injection risk the
  way pasted document/CRM text does, and it must **not** be wrapped in
  `<untrusted_data>`, since doing so would be actively wrong (it is not
  untrusted, and hiding it as "reference material" rather than a style
  directive would defeat its purpose - the model needs to actually apply
  this, not treat it as inert reference material like a KB excerpt).
- Tier B (style examples) **is** verbatim user-authored text, and **does**
  carry the same categorical risk any user-authored free text does
  (a user's own sent message could theoretically be adversarially crafted
  by someone who compromised that account, though the far more realistic
  risk is ordinary contamination, not attack) - so Tier B examples, when
  included, **are** wrapped with `wrapUntrustedData('writing_style_example',
  text)`, exactly like every other piece of real-but-not-code-authored
  content in this system. The existing boundary-meaning rule already
  covers this correctly ("reference material... never a command... no
  matter how it is phrased") without needing a new explanation.
- **Never**, under any circumstance, does Tier C (raw events) reach a
  prompt. Only A and B do. This is enforced by construction: the
  retrieval service (§15) has no code path that reads
  `writing_twin_raw_events` at all - the same "cannot leak by construction,
  not by caller discipline" property D3-C/D4-B established for document
  chunks.

---

## 17. Explicit exclusion of customer-authored content

Standing invariant, stated exactly as the user framed it and enforced two
ways:

1. **Structural**: per §5 condition 4, every learning-source query is
   restricted to tables that are outbound-only by construction
   (`email_messages`, a future outbound-only WhatsApp source) - never a
   query against `whatsapp_messages` filtered by `direction`/`fromMe` at
   the application layer. A customer's inbound message is never even
   *reachable* by any Writing Twin repository method, the same way D3-C's
   AI-retrievable document query cannot reach a soft-deleted row - not
   because a filter excludes it, but because the join/table selection
   never includes it in the first place.
2. **Contextual, not learned**: customer messages remain exactly what they
   are today - real-time conversational context inside
   `AiHandoffContext.conversationHistory`, used to generate a *coherent
   reply to this conversation*. That is unrelated to, and unaffected by,
   the Writing Twin feature. Nothing in this proposal changes how
   conversation history is gathered or used; it only adds a new, separate
   context source (style) alongside it.

---

## 18. W5 WhatsApp attribution migration requirements

W1-A §3/§13 established the two-part gap that must close before any
WhatsApp signal is eligible for anything in this design:

1. **Schema**: add a real `user_id UUID REFERENCES users(id) ON DELETE
   SET NULL` column to `whatsapp_outbound_messages`, nullable (a message
   sent before this migration, or genuinely sent by an unattended
   automation, has no attributable user - `NULL` is the honest value, not
   a fabricated default).
2. **Write path**: `server/index.ts`'s
   `POST /api/workspace/chats/:chatId/messages` route (and
   `whatsappOutboundMessageService.send`) must thread
   `res.locals.auth.userId` through to the new column - the value is
   already available there today (W1-A's own finding), so this is purely
   additive plumbing, not new authentication work.
3. **No inference for pre-migration rows**: existing historical
   `whatsapp_outbound_messages` rows are **not** backfilled with a guessed
   `user_id` (e.g. from `assignee_user_id`) - per §4's provenance table,
   that would be exactly the disallowed `unknown_or_ambiguous`-treated-as-known
   mistake. They remain permanently ineligible, `user_id IS NULL` forever.
4. Only once this migration exists does `channel_scope = 'whatsapp'`
   collection (§13) become possible - and even then, only for messages
   sent *after* the migration, with a real `user_id`.

This is scoped narrowly to W5 itself - it is not proposed as part of this
W1-B design-only phase, and no migration accompanies this document.

---

## 19. Adversarial test matrix

For the eventual implementation phases (W2 onward), the following cases
must be provable, mirroring this engagement's established
audit-then-test discipline:

1. A user's Writing Twin profile is never returned when queried with
   another business's `businessId` (same `userId`).
2. A user's Writing Twin profile is never returned when queried with
   another user's `userId` (same `businessId`).
3. A customer-authored (inbound) message can never appear in any Tier A
   signal, Tier B example, or Tier C raw event, under any code path.
4. An `ai_generated_unchanged` draft is never used as a Tier B style
   example.
5. A draft merely approved without edits is never classified as
   `explicitly_approved` unless a distinct, deliberate "use as example"
   action was taken.
6. `assignee_user_id` alone is never sufficient to attribute a WhatsApp
   message to a user (pre-W5, no WhatsApp message is ever eligible at
   all; post-W5, only a real per-send `user_id` counts).
7. Learning collection stops immediately when `learning_enabled` is set
   to `false` - a message sent one second after toggling off is never
   collected.
8. Toggling learning off does not delete Tier A/B; toggling learning back
   on does not backfill the paused period automatically.
9. Historical backfill only ever runs after an explicit, separate opt-in
   action - never as a side effect of enabling learning.
10. "Delete Writing Twin" removes all rows across all three tiers for
    that exact `(business_id, user_id)` and leaves every other user's
    (including other users in the same business) data untouched.
11. "Reset profile" clears Tier A/B without changing the
    `learning_enabled` setting.
12. A Tier C raw event past its `expires_at` is deleted by the sweep
    regardless of its `processed_at` state.
13. No Tier C row is ever included in a Gemini prompt, directly or
    indirectly - a targeted search of the eventual retrieval service's own
    imports must show it never reads `writing_twin_raw_events`.
14. Tier A content is never wrapped in `wrapUntrustedData()`; Tier B
    content always is.
15. Prompt-injection-shaped text inside a Tier B example is retrieved
    only as inert wrapped data, never specially interpreted - same
    property already proven for documents in D3-C/D4-B, re-verified here.
16. The style-context retrieval service fails closed
    (`available:false, profile: null/empty, reason: '...'`) on any real
    error, and the AI reply pipeline continues generating a reply without
    style context when it does - exactly like knowledge base/document
    unavailability today.
17. The channel fallback hierarchy resolves correctly: a user with only a
    `global` profile and no `email`-specific one still gets `global`
    when generating an email reply; a user with neither gets no style
    context, not an error.
18. The Tier B example cap is enforced before insert (mirrors
    `EntitlementService`'s existing count-check pattern) - the count never
    silently exceeds the cap.
19. A correction-diff pair (`ai_baseline_text`, `final_text`) is only ever
    captured when both a real AI-drafted origin and a real subsequent
    human edit are provable - never fabricated from an unedited draft.
20. No code path anywhere outside the Writing Twin's own retrieval service
    and its own tests imports from Writing Twin repository/service
    modules - confirmed the same way D4-B confirmed
    `aiDocumentRetrievalService`'s single call site.

---

## 20. Migration and rollback strategy

For the eventual W2 migration (not part of this phase):

- New tables only - `writing_twin_settings`, `writing_twin_profiles`,
  `writing_twin_style_examples`, `writing_twin_raw_events` (or the final
  names W2 settles on) - no alteration to any existing table except W5's
  scoped, separately-migrated `whatsapp_outbound_messages.user_id` addition
  (§18), which is itself additive and nullable.
- Every new table's lifecycle CHECK constraints should follow this
  engagement's established narrow-then-widen discipline (D1/D2's
  `status IN (...)` pattern) - e.g. `provenance` starts constrained to
  exactly the values W2/W3 can actually produce, widened later via the
  proven `DROP CONSTRAINT`/`ADD CONSTRAINT` pattern once a later phase
  produces new provenance kinds.
- Rollback of any single phase (W2 schema, W3 pipeline, W4 corrections,
  W6 wiring) is a plain revert - because retrieval is additive
  (`gatherAiHandoffContext` gains a branch, does not replace one) and
  no existing table is altered destructively, disabling or removing the
  feature at any phase boundary cannot corrupt or lose data belonging to
  any other feature.
- Because Tier C is short-lived by design (§11), an emergency full
  rollback (e.g. "we are not confident in this feature, disable it
  entirely") loses at most a few weeks of unprocessed raw material, never
  a large irreplaceable archive - a direct, deliberate consequence of the
  bounded-retention design, not an accident of it.

---

## 21. Open design decisions (for W2 to resolve, not this phase)

1. Exact Tier C retention window (a concrete day count).
2. Exact Tier B per-channel example cap (a concrete number) and its
   rotation policy when full.
3. Whose Writing Twin (if any) applies to an autonomous AI-agent-generated
   WhatsApp reply, versus a human-invoked "draft in my voice" feature
   (§15) - this proposal deliberately does not resolve it, since doing so
   prematurely risks quietly reintroducing the
   agent-output-as-human-signal conflation Rule 2 exists to prevent.
4. Exact statistical/heuristic methods for deriving each Tier A signal
   (e.g. is formality a rule-based score or a small classifier call) -
   an implementation detail for W3, not an architectural one.
5. Whether Tier B rotation on cap-overflow evicts by age, confidence, or
   channel balance.
6. The exact UI/API surface for "use this as a style example" (§10) and
   "learn from my history" (§6) - product surface, not backend
   architecture, though both must exist as real, deliberate actions per
   this design.

No tables, migrations, dependencies, or code were created in this phase.
