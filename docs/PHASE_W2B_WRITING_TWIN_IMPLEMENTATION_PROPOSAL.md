# Phase W2-B: Writing Twin Implementation Proposal

**Status: proposal only. No migration and no code changes in this phase.**
Builds on W1-A, W1-B, and W2-A. This document is the last design artifact
before any Writing Twin table or code is created - it exists to be
reviewed and approved, not executed. Structured in the exact pipeline
order requested: proposed migration → exact SQL/schema changes →
repository interfaces → service interfaces → authorization paths → AI
integration boundary → tests → rollback plan, with the 14 required
coverage items and the per-table questions answered inline throughout
rather than as a disconnected checklist.

---

## 0. The single load-bearing design change from W2-A

W2-A proposed four tables with two independent FKs each
(`business_id → businesses(id)`, `user_id → users(id)`). This proposal
**replaces that with one composite foreign key per table**, and **adds a
fifth table** to make derived-profile provenance a real, FK-enforced
relationship rather than an unconstrained array. Both changes come
directly from this authorization's two hardest requirements (composite
membership integrity; derived-profile provenance), so they are stated up
front before the detailed schema.

---

## 1 & 2. Exact foreign-key relationships and composite membership integrity

**Re-confirmed against live code**: `business_memberships` (migration
`035_create_auth_foundation.sql:37`) has `UNIQUE (business_id, user_id)`,
and its only removal path is a real, permanent
`DELETE FROM business_memberships WHERE id = $1`
(`businessMembershipRepository.ts:134-136`, called `remove()`) - there is
no `status = 'suspended'` code path anywhere in the current codebase
(the column exists in the type but no method sets it), so membership
removal today is exclusively a hard delete, never a soft one.

**Proposed constraint**, replacing W2-A's two independent single-column
FKs on every Writing Twin table:

```sql
FOREIGN KEY (business_id, user_id)
  REFERENCES business_memberships (business_id, user_id)
  ON DELETE CASCADE
```

This is strictly stronger than storing `business_id`/`user_id`
independently: it is no longer merely "both values happen to reference
something real," it is "this exact business+user pairing is a real,
currently-existing membership." A row that tried to combine a real
`business_id` with a real `user_id` who is not actually a member of that
business is rejected at the database level - exactly the requirement
("must exist in business_memberships," not "merely store both IDs
independently").

**This also directly answers the `writing_twin_settings` question "what
happens if the business membership is removed?"**: `ON DELETE CASCADE`
means removing a member automatically, atomically, deletes every one of
that user's Writing Twin rows for that business, in the same statement -
no application code has to remember to do this, and no window exists
where a removed member's Writing Twin data outlives their membership.
This is a stronger, structural version of the deletion-propagation
requirement (§ Deletion propagation, below) for this one specific
trigger.

Since `business_memberships.business_id` and `.user_id` are themselves
`REFERENCES businesses(id)`/`REFERENCES users(id)` (unchanged, existing
constraints), referential integrity to `businesses`/`users` is preserved
transitively - a Writing Twin row can never reference a nonexistent
business or user either, exactly as before, just enforced through one
constraint instead of two independent ones.

*(If a future phase introduces real membership suspension - `status =
'suspended'` without a row deletion - that is explicitly a separate
product decision this proposal does not make: a composite FK against
`(business_id, user_id)` alone does not distinguish `status = 'active'`
from `status = 'suspended'`, since both are still real rows. Whether a
suspended-but-not-removed member's Writing Twin should pause is left
open, matching W1-B §21's discipline of not deciding things prematurely -
today's only real transition is removal, and that is what this proposal
makes airtight.)*

---

## 3. One-versus-many / versioning strategy, per table

### `writing_twin_settings` - **not versioned, single mutable row**

Exactly one row per `(business_id, user_id)` (`UNIQUE` constraint,
unchanged from W2-A). Not versioned: this table holds *current state*
(is learning on right now, has backfill run), not a history of past
states. `updated_at` is sufficient for "when did this last change" if
ever needed; a full change-history table is not proposed, since nothing
in this feature's requirements needs to answer "what was
`learning_enabled` set to on a specific past date," only "what is it set
to now." **Deletion is permanent** (a real `DELETE`, not a soft-delete
flag) - explicitly rejecting soft deletion for every Writing Twin table,
since a feature whose entire premise is genuine user-controlled erasure
cannot itself rely on a "deleted" flag that leaves the row (and its
content) physically present and potentially still readable by a
forgotten query path.

### `writing_twin_profiles` - **versioned, exactly one current version per channel**

This is the one place W2-A's design changes materially, to satisfy the
derived-profile-provenance requirement honestly. Each computed profile is
a new, immutable row (`version_number` incrementing), never an in-place
`UPDATE` of the previous one:

```sql
CREATE TABLE writing_twin_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  user_id UUID NOT NULL,
  channel_scope TEXT NOT NULL CHECK (channel_scope IN ('global', 'email', 'whatsapp')),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  is_current BOOLEAN NOT NULL DEFAULT true,

  -- Same schema-bound, CHECK-constrained signal columns as W2-A §5.2
  -- (preferred_tone, formality, greeting_style, sign_off_style,
  -- avg_sentence_length_bucket, punctuation_emphasis, emoji_frequency,
  -- directness, question_pattern, common_phrases, common_sign_offs) -
  -- unchanged from W2-A, not repeated here for brevity.

  example_count INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,

  FOREIGN KEY (business_id, user_id) REFERENCES business_memberships (business_id, user_id) ON DELETE CASCADE,
  UNIQUE (business_id, user_id, channel_scope, version_number)
);

CREATE INDEX idx_writing_twin_profiles_user ON writing_twin_profiles (business_id, user_id, channel_scope);

-- Structurally enforces "exactly one current version" - not
-- application discipline. A partial unique index rejects a second
-- concurrent is_current=true row for the same triple outright.
CREATE UNIQUE INDEX idx_writing_twin_profiles_current
  ON writing_twin_profiles (business_id, user_id, channel_scope)
  WHERE is_current;
```

- **How the active profile is selected**: `WHERE is_current = true` -
  never "most recent by `computed_at`" (which would be a race-prone,
  non-atomic read pattern); the partial unique index makes "current" an
  actual, singular, database-enforced fact, not a derived one.
- **Older versions remain for audit/history**: yes, by design -
  `is_current` flips to `false` and `superseded_at` is stamped when a new
  version is computed; the old row is never deleted by ordinary
  recomputation (only by full Writing Twin deletion, §Deletion
  propagation).
- **Can a profile exist without sufficient evidence?** No row is created
  at all until at least one eligible Tier B example exists for that
  `channel_scope` - "no profile yet" is represented by the honest absence
  of a row (matching every other honest-empty-result convention in this
  codebase), never by an existing-but-empty placeholder row with
  `example_count = 0`. The retrieval service (§ AI integration boundary)
  treats "no row" and "row exists with real signal" as the only two
  states it needs to distinguish; there is no third "empty but present"
  state to reason about.

### `writing_twin_style_examples` - **not versioned; each example is its own immutable row**

Individual examples are never edited in place (an example is either
present or deleted, matching Tier C's evidence-immutability principle) -
"versioning" doesn't apply to an individual example the way it does to a
derived profile; the *set* of examples changes over time as examples are
added/removed/rotated, but no single example row changes. Per-example
questions answered in §9 below.

### `writing_twin_raw_events` - **not versioned; append-only until expiry-deleted**

Each raw event is a single immutable row from creation to deletion (never
updated except to stamp `processed_at`) - there is no concept of
"versions" of a raw event, only its lifecycle state (unprocessed →
processed → expired/deleted). Detailed in §11.

### New: `writing_twin_profile_derivations` - **the provenance join table**

```sql
CREATE TABLE writing_twin_profile_derivations (
  profile_version_id UUID NOT NULL REFERENCES writing_twin_profiles(id) ON DELETE CASCADE,
  style_example_id UUID NOT NULL REFERENCES writing_twin_style_examples(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_version_id, style_example_id)
);
```

This is the concrete, FK-enforced answer to the required derived-profile
provenance question (`profile_version → derived_from → style_example
IDs`), chosen over a plain `UUID[]` column specifically because a plain
array cannot be validated by a foreign key - the user's own stated
principle ("if PostgreSQL can enforce the relationship structurally, do
not merely store IDs independently") applies here exactly as it does to
business membership. Two consequences fall directly out of the `ON
DELETE CASCADE` on `style_example_id`:

- **When a user deletes an example**, every derivation row referencing it
  is atomically removed - the profile version's row is untouched, but its
  *recorded provenance is now demonstrably incomplete* (see next point).
- **Staleness is detectable, not assumed**: a profile version's
  `example_count` (captured at computation time) can be compared against
  `SELECT count(*) FROM writing_twin_profile_derivations WHERE
  profile_version_id = $1` at read time. If the live count is lower than
  the recorded `example_count`, at least one underlying example the
  profile was built from has since been deleted - the profile is stale
  and the retrieval service (§ AI integration boundary) must not present
  it as current, valid style guidance without W3 recomputing it. This is
  the concrete mechanism satisfying: *"The system must know when a
  profile is no longer valid because one of its underlying evidence
  sources disappeared."*

---

## 4. Deletion propagation - the full path

The user's required diagram, made concrete against this codebase's real
primitives:

```
DELETE REQUEST (settings-page action, authenticated)
      ↓
requirePermission (existing auth middleware) + res.locals.auth.userId
      ↓
businessExecutionContextForUser(businessId, userId)   -- domain/businessExecutionContext.ts,
      ↓                                                   already built, unused until now -
      ↓                                                   this is its first real consumer
WritingTwinService.deleteAll(context)
      ↓
withTransaction(async (client) => {
  const repo = new WritingTwinRepository(client);
  await repo.deleteRawEvents(businessId, userId);          -- Tier C
  await repo.deleteProfileDerivations(businessId, userId);  -- provenance join rows
  await repo.deleteStyleExamples(businessId, userId);       -- Tier B
  await repo.deleteProfiles(businessId, userId);            -- Tier A (all versions)
  await repo.deleteSettings(businessId, userId);             -- settings row
})
      ↓
security_audit_logs.record({ eventType: 'writing_twin_deleted', businessId, actorId: userId, requestId: context.requestId })
      ↓
(if any cache exists in a future phase) cache.invalidate(businessId, userId) -- inside the same transaction's success path, see below
      ↓
transaction commits
      ↓
response returned to caller
```

**"future AI context invalidated"** - concretely: because the AI
retrieval service (§ AI integration boundary) reads Postgres directly on
every call with no caching layer (mirroring `aiDocumentRetrievalService`/
`knowledgeBaseSearchService`'s proven pattern), there is nothing to
separately invalidate for this today - the very next `gatherAiHandoffContext`
call after the transaction commits will simply find no rows and return an
honest empty/unavailable style context. **This is the actual consistency
strategy for a cache that cannot participate transactionally**, stated
explicitly per the user's requirement: *no cache exists in this
proposal's design*, so there is no window where deleted data could still
be served through one. If a future phase introduces a cache (§12), that
phase must extend `WritingTwinService.deleteAll` to call the cache's
invalidation *inside the same request*, before returning success to the
caller - not queued, not eventual, not best-effort. A cache that cannot
be synchronously invalidated within this call is not an acceptable design
for this feature; that is the binding constraint this proposal places on
any future cache, not merely a hope.

**"derived data invalidated"** - the `writing_twin_profile_derivations`
CASCADE (§3) already handles this for the "one example deleted"
case; for full deletion, Tier A/B/derivation rows are removed in the same
transaction as everything else, so there is no separate "derived data"
step to reason about beyond the ordering above.

---

## 5. Raw event lifecycle - what qualifies, storage, encryption, retention

Directly answering every required sub-question for `writing_twin_raw_events`:

- **What exactly qualifies as a raw event**: the source material behind
  exactly one learning-eligible outbound message, in one of two shapes -
  a `human_authored`/`explicitly_approved` sent message (`final_text`
  only, `ai_baseline_text` NULL), or an `ai_generated_then_edited`
  correction pair (`ai_baseline_text` = the AI's original draft,
  `final_text` = what was actually sent). One row per source message -
  never a batch, never a conversation-level aggregate.
- **Whether raw text is stored**: yes, `final_text` (and, for corrections,
  `ai_baseline_text`) are stored verbatim - this tier's entire purpose is
  to be the input to extraction (§ AI integration boundary is Tier A/B
  only; Tier C feeds the *extraction step*, a separate concern). What
  changes from W2-A is *how* it is stored (encryption, next point).
- **Encryption requirement**: **yes, both text columns are encrypted at
  rest**, reusing `EncryptionService.encryptField(tenantId, plaintext)`
  exactly as `whatsapp_messages.text_content` already does
  (`tenantId = businessId`). This is a safe reuse, not a new mechanism:
  W1-B/W2-A's earlier reasoning against encrypting `business_document_chunks.text`
  was specifically that column needed native Postgres full-text search
  (a GIN index over plaintext) and this codebase has no working precedent
  for searching an encrypted column. **Tier C has no such requirement** -
  it is never searched by content, only ever fetched by
  `(business_id, user_id, channel_scope)` and a row `id`, exactly the
  access pattern `whatsapp_messages.text_content` already uses
  successfully today. The same reasoning extends to
  `writing_twin_style_examples.example_text` (Tier B) - also verbatim
  personal text, also never content-searched, also encrypted the same
  way. **Tier A's `common_phrases`/`common_sign_offs` are deliberately
  left unencrypted** - they are short (≤80/40 chars), heavily bounded
  (≤8/5 elements), already a step removed from raw source text (curated
  as "common" patterns, not a copy of any single message), and this
  proposal judges the operational cost of encrypting a small bounded
  array not proportionate to its residual sensitivity; this is flagged
  as an explicit, reconsiderable decision, not an oversight.
- **Retention period**: a concrete default of **60 days** is proposed
  here (resolving W1-B §21's open item) - long enough for W3's extraction
  job to run on a reasonable schedule even accounting for a backlog, short
  enough that "unlimited permanent archive" is never a credible
  description of this table. Configurable per-deployment via an
  environment variable (matching this codebase's existing
  `envInt(...)`-style configuration convention, e.g. in `agentGuard.ts`),
  not hardcoded where it can't be tuned without a code change.
- **`expires_at` calculation**: computed once, at insert time -
  `created_at + (WRITING_TWIN_RAW_EVENT_RETENTION_DAYS || 60) days` -
  never recomputed or extended later, matching W2-A §7's fixed-at-write
  design exactly.
- **Automatic cleanup**: a scheduled sweep worker (new in W3, not this
  phase), mirroring the existing stale-job-sweep pattern
  (`whatsapp_outbound_messages_pending_idx` and equivalents), running
  `DELETE FROM writing_twin_raw_events WHERE expires_at < now()` on an
  interval, using the `idx_writing_twin_raw_events_expiry` index (W2-A
  §5.4, unchanged).
- **User deletion / business deletion**: covered structurally by §1/§2's
  composite FK `ON DELETE CASCADE` - a user or business being removed
  (however that eventually happens elsewhere in this codebase) cascades
  through `business_memberships` to every Writing Twin table including
  Tier C, with no separate cleanup step required.
- **Whether expired content can ever be used by training or profile
  regeneration**: **no - "expired = inaccessible and ineligible,"
  exactly as required, not merely hidden from default queries.**
  Concretely: (a) the sweep deletes expired rows promptly on a real
  schedule, so an expired row does not persist waiting to be
  reconsidered; (b) independently of the sweep's timing,
  `listUnprocessedRawEvents` (the *only* repository method any W3
  extraction/processing code is permitted to call to read Tier C) filters
  `WHERE expires_at > now()` unconditionally, so a row that has expired
  but not yet been swept is invisible to processing regardless of the
  sweep's current lag; (c) **no other method on `WritingTwinRepository`
  exposes Tier C reads at all** - there is no generic "get raw event by
  id" method a future caller could use to bypass the expiry filter, the
  same narrow-dedicated-method discipline as every other tier. This
  three-layer guarantee (prompt deletion + universal filter on the one
  read method + no alternate read path) is what makes "ineligible," not
  merely "hidden," a true statement rather than an aspiration.

  *(Row Level Security was considered and explicitly not proposed here:
  this codebase has no existing RLS precedent anywhere - every tenant/
  eligibility boundary in this system, including D3-C's proven document
  isolation, is enforced through narrow repository methods with the
  predicate baked into the query, not database roles/policies. Introducing
  RLS for this one feature would add a second, inconsistent enforcement
  paradigm rather than reusing the one this whole engagement has already
  validated repeatedly. If a future security review judges RLS
  necessary, that is a cross-cutting decision affecting every tenant-
  scoped table in this codebase, not a Writing-Twin-specific one.)*

---

## 6. Bounded style examples - remaining sub-questions (Tier B)

- **Maximum examples per user**: **30 per `(business_id, user_id,
  channel_scope)`**, resolving W1-B §21's open item with a concrete
  number - large enough to give the model real stylistic range, small
  enough that Tier B remains a curated demonstration set, not a
  transcript archive. Configurable via
  `WRITING_TWIN_MAX_EXAMPLES_PER_CHANNEL`, same convention as retention.
- **Maximum size per example**: `example_text` `CHECK (length(...) <=
  2000)` - unchanged from W2-A, matching the existing
  `SNIPPET_LENGTH`/chunking-precedent discipline of bounding any
  individual piece of stored text.
- **How provenance is represented**: `source_provenance` `CHECK`-restricted
  to exactly `('human_authored', 'ai_generated_then_edited',
  'explicitly_approved')` - unchanged from W2-A, the strongest layer of
  W1-B §4's five-state model.
- **Can examples be manually removed?** Yes - a real, user-facing
  "remove this example" action, backed by
  `WritingTwinRepository.deleteStyleExample(businessId, userId, exampleId)`
  (tenant/user-scoped, per D3-C's discipline). This is a distinct,
  smaller-scoped action from full "Delete Writing Twin" (§4).
- **Are deleted examples immediately excluded from future profile
  generation?** Yes, in the most direct possible sense: a deleted row no
  longer exists, so any future extraction/regeneration query (which only
  ever reads currently-live rows) cannot see it - there is no
  "soft-deleted but still queryable" intermediate state for this table
  either. And per §3's `writing_twin_profile_derivations` cascade,
  *already-computed* profile versions that depended on the deleted
  example become detectably stale immediately, not just future
  computations.
- **Rotation policy on cap overflow**: oldest-first eviction
  (`deleteOldestStyleExample`, W2-A §10) is the proposed default - simple,
  predictable, and consistent with this codebase's general preference for
  straightforward, explainable policies over more complex
  confidence-weighted rotation, which W1-B §21 explicitly left open and
  this proposal resolves with the simplest defensible choice rather than
  building unneeded sophistication into V1.

---

## 7. Background-job ownership binding

Applies to two future W3 job families - extraction (raw event → Tier A/B)
and the expiry sweep - specified here as a binding requirement for
whichever phase actually implements them:

- **Every extraction job payload** (a BullMQ job, matching
  `DocumentParseJobData`'s shape/precedent in
  `src/queue/queues/documentParseQueue.ts`) must carry exactly
  `{ businessId, userId, channelScope, requestId }` - `requestId` sourced
  from the `BusinessExecutionContext.requestId` that triggered the job
  (e.g. the request that enabled learning, or a scheduled per-user tick),
  never generated fresh inside the worker.
- **The job handler must re-derive its own `BusinessExecutionContext`**
  at execution time via `businessExecutionContextForSystem(businessId)`
  (for a scheduled/system-triggered run) or reconstruct the user-scoped
  one from the payload's `businessId`/`userId` - and **every repository
  call the handler makes must pass that exact `businessId`/`userId`
  through**, never a value read from any ambient/global/"current business"
  state. This directly prevents the failure mode the user described:
  *"job created under Business A → later executes → uses current/default
  business → writes into Business B."* Because every
  `WritingTwinRepository` method requires `businessId`/`userId` as
  explicit parameters (§ Repository interfaces) with no default or
  ambient fallback, there is structurally no "current business" for a
  job handler to accidentally read instead of its own payload - the same
  protection D3-C's dedicated-method discipline provides against a
  caller *forgetting* the scope, applied here against a caller
  *substituting the wrong* scope.
- **The sweep job is the one deliberate exception** (§ Repository
  interfaces, `sweepExpiredRawEvents()`) - it is intentionally
  tenant-agnostic (a `DELETE ... WHERE expires_at < now()` across all
  businesses/users in one statement, matching the existing stale-job
  sweep precedent), since a time-based deletion has no "wrong business"
  failure mode to guard against - it either deletes an expired row or it
  does not, for every tenant equally.

---

## 8. Transaction boundaries

- **Deletion** (§4): one `withTransaction` call across all five tables
  (including the derivation join table), all-or-nothing.
- **Profile computation** (W3, specified here for the eventual
  implementer): creating a new profile version and flipping the previous
  `is_current` row to `false` must happen in one transaction - the
  partial unique index (§3) would reject a moment where two rows are
  simultaneously `is_current = true`, so the write order must be
  `UPDATE ... SET is_current = false, superseded_at = now() WHERE
  is_current = true AND ...` **before** inserting the new
  `is_current = true` row, both inside the same transaction, so the
  index's constraint is never transiently violated.
- **Example addition with cap enforcement**: `countStyleExamples` (to
  check the cap) and the subsequent `INSERT`/eviction must happen in one
  transaction to avoid a race where two concurrent additions both pass
  the count check and jointly exceed the cap - mirroring
  `EntitlementService`'s existing count-then-insert pattern, which this
  codebase already relies on without a stricter locking mechanism (an
  accepted, existing precedent this proposal does not need to improve on).
- **Every other read** (settings check, profile retrieval, example
  listing) is a single-statement read, needing no explicit transaction.

---

## 9. Migration strategy

- One new migration, `069_writing_twin.sql` (next available number,
  confirmed in W2-A §1-4), creating five new tables
  (`writing_twin_settings`, `writing_twin_profiles`,
  `writing_twin_style_examples`, `writing_twin_raw_events`,
  `writing_twin_profile_derivations`) and zero `ALTER TABLE` statements
  against any existing table.
- W5's `whatsapp_outbound_messages.user_id` addition (W1-B §18) remains
  explicitly out of scope for this migration - a separate, later,
  additive migration in its own right, gating WhatsApp channel
  eligibility, not bundled here.
- Every enum-shaped `CHECK` (`channel_scope`, `source_provenance`,
  `provenance`, every Tier A signal column) follows the established
  narrow-then-widen convention - each starts constrained to exactly the
  values this design specifies, widened later via the proven `DROP
  CONSTRAINT`/`ADD CONSTRAINT` pattern if a future phase needs to add a
  value (e.g. a new channel).

---

## 10. Existing-table compatibility

Zero existing tables are altered by this migration. The only *other*
touch point in the existing schema is read-only: extraction (W3) reads
`email_messages`/`whatsapp_outbound_messages` (once W5 lands) to source
raw events, but writes nothing back to them - no new column, no new
trigger, no new constraint on any pre-existing table. This preserves
D1-D4's entire existing surface untouched, exactly as every prior phase
in this engagement has done.

---

## 11. Repository interfaces

```ts
// src/repositories/writingTwinRepository.ts (proposed, not created)

export type ChannelScope = 'global' | 'email' | 'whatsapp';
export type Provenance = 'human_authored' | 'ai_generated_then_edited' | 'explicitly_approved';

export class WritingTwinRepository {
  constructor(private readonly db: Queryable) {}

  // Settings
  async getSettings(businessId: string, userId: string): Promise<WritingTwinSettings | null>;
  async setLearningEnabled(businessId: string, userId: string, enabled: boolean): Promise<void>;
  async recordBackfillRequested(businessId: string, userId: string): Promise<void>;
  async recordBackfillCompleted(businessId: string, userId: string): Promise<void>;

  // Tier A (profiles)
  async getCurrentProfile(businessId: string, userId: string, channelScope: ChannelScope): Promise<WritingTwinProfile | null>;
  async getAllCurrentProfilesForUser(businessId: string, userId: string): Promise<WritingTwinProfile[]>; // backs the channel fallback hierarchy
  async isProfileStale(businessId: string, userId: string, profileVersionId: string): Promise<boolean>; // compares live derivation count to example_count, per §3
  async createProfileVersion(businessId: string, userId: string, channelScope: ChannelScope, signals: WritingTwinSignals, derivedFromExampleIds: string[]): Promise<WritingTwinProfile>; // handles the is_current flip + derivation rows in one transaction, per §8

  // Tier B (examples)
  async countStyleExamples(businessId: string, userId: string, channelScope: ChannelScope): Promise<number>;
  async listStyleExamples(businessId: string, userId: string, channelScope: ChannelScope, limit: number): Promise<WritingTwinStyleExample[]>;
  async addStyleExample(businessId: string, userId: string, channelScope: ChannelScope, provenance: Provenance, exampleText: string, sourceTable: string, sourceRowId: string): Promise<WritingTwinStyleExample>; // enforces the cap + rotation, per §6/§8
  async deleteStyleExample(businessId: string, userId: string, exampleId: string): Promise<void>;

  // Tier C (raw events)
  async recordRawEvent(businessId: string, userId: string, channelScope: ChannelScope, provenance: Provenance, finalText: string, aiBaselineText: string | null, sourceTable: string, sourceRowId: string): Promise<void>; // encrypts finalText/aiBaselineText before insert, per §5
  async listUnprocessedRawEvents(businessId: string, userId: string, channelScope: ChannelScope): Promise<WritingTwinRawEvent[]>; // WHERE expires_at > now() AND processed_at IS NULL - the ONLY Tier C read method
  async markRawEventProcessed(businessId: string, userId: string, id: string): Promise<void>;
  async sweepExpiredRawEvents(): Promise<number>; // the one tenant-agnostic method, per §7

  // Deletion (§4)
  async deleteAllForUser(businessId: string, userId: string): Promise<void>; // one withTransaction call across all five tables
  async resetProfile(businessId: string, userId: string): Promise<void>; // Tier A + B + derivations only, settings untouched
}
```

**No method accepts a bare `id` without `businessId`/`userId` alongside
it, and no method accepts an `agentId`** - the fail-closed
AI-attribution boundary approved in W2-A, re-affirmed here as unchanged
by this proposal's revisions. `sweepExpiredRawEvents()` remains the one
deliberate, justified exception (§7).

---

## 12. Service interfaces

```ts
// src/services/writingTwinService.ts (proposed, not created)

export interface WritingTwinContext {
  available: boolean;
  profile: WritingTwinStyleSummary | null; // rendered as trusted instruction content, never raw examples
  reason: string | null;
}

export class WritingTwinService {
  // Settings / lifecycle
  async getSettings(context: BusinessExecutionContext): Promise<WritingTwinSettings>; // context.actorType must be 'user'; throws/rejects otherwise
  async setLearningEnabled(context: BusinessExecutionContext, enabled: boolean): Promise<void>;
  async requestHistoricalBackfill(context: BusinessExecutionContext): Promise<void>; // enqueues the explicit-opt-in backfill job, per W1-B §6
  async deleteAll(context: BusinessExecutionContext): Promise<void>; // the full deletion propagation path, §4
  async resetProfile(context: BusinessExecutionContext): Promise<void>;
  async removeStyleExample(context: BusinessExecutionContext, exampleId: string): Promise<void>;

  // Retrieval into the AI pipeline (§ AI integration boundary)
  async retrieveWritingTwinContext(businessId: string, userId: string, channelScope: ChannelScope): Promise<WritingTwinContext>;
}
```

Every method except `retrieveWritingTwinContext` takes a
`BusinessExecutionContext`, not raw `businessId`/`userId` strings - this
is a deliberate escalation beyond W2-A's repository-level design,
because these are the actual user-facing/API-facing entry points where
"where did this identity come from" matters most (matching the domain
type's own stated purpose: "every factory... derives businessId/actorType/
actorId from something the server itself already authenticated"). The one
exception, `retrieveWritingTwinContext`, is called from
`aiContextGathererService.ts`'s `Promise.all` (§ AI integration boundary)
where `businessId` is already the established convention every other
branch uses directly (matching `searchKnowledgeBase(businessId,
queryText)`/`retrieveAiDocumentContext(businessId, queryText)`'s existing
signatures exactly) - introducing `BusinessExecutionContext` there would
be an inconsistent, unjustified deviation from D4-B's proven pattern for
that one specific call site.

**Fail-closed check inside every user-facing method**: each method
asserts `context.actorType === 'user' && context.actorId` before doing
anything - a `BusinessExecutionContext` constructed via
`businessExecutionContextForAiCell` or `businessExecutionContextForSystem`
is rejected outright by every one of these methods except the internal
sweep. This is the service-layer half of the AI-attribution fail-closed
boundary; §11's repository-layer half (no `agentId`-accepting method
exists at all) is the other.

---

## 13. Authorization paths

- **Settings/lifecycle routes** (`GET/PUT /api/workspace/writing-twin/settings`,
  `POST .../delete`, `POST .../reset`, `DELETE .../examples/:id`,
  proposed route shapes, not created): gated by ordinary session
  authentication (the existing `requirePermission`/`res.locals.auth`
  pattern every other authenticated route in this codebase uses) - **no
  new permission is proposed**, since Writing Twin settings are
  inherently self-service and personal (a user manages only their own
  twin), unlike `settings.manage` (business-wide). The authorization
  check *is* the identity check: `res.locals.auth.userId` is the only
  `userId` any of these routes can ever operate on - there is no "manage
  another user's Writing Twin" capability proposed at any permission
  level, consistent with W1-B's Rule 1 and this authorization's final
  requirement (§ Final requirement, below).
- **Historical backfill** additionally requires the explicit, separate
  opt-in action already specified in W1-B §6 - the route exists, but
  calling it is never a side effect of any other action.
- **AI retrieval path**: no HTTP route at all - `retrieveWritingTwinContext`
  is called only from within `gatherAiHandoffContext`, server-side,
  never exposed as a directly callable API endpoint (mirroring
  `retrieveAiDocumentContext`'s own D4-B precedent of having no direct
  HTTP route, since exposing document/style retrieval as its own public
  endpoint was never a requirement and would only widen the attack
  surface unnecessarily).

---

## 14. AI integration boundary

Reuses D4-B's exact insertion shape in `aiContextGathererService.ts`:

```ts
retrieveWritingTwinContext(businessId, userId, channelScope)
```

**Where `userId` comes from is the open question this proposal must
answer for the boundary to be real**, and it resolves it the way W1-B
§15 and this authorization's own instruction require: **there is no
`userId` available in the current WhatsApp AI-agent reply path at all**
(`gatherAiHandoffContext`'s existing `GatherAiHandoffContextInput` has no
`userId` field, and none is proposed to be added by this phase). This
proposal therefore does **not** wire Writing Twin retrieval into the
autonomous WhatsApp AI-agent reply path in this phase - doing so would
require inventing a `userId` from somewhere (the business owner? the
chat's `assignee_user_id`? both explicitly rejected as unsafe
substitutions by W1-A §13 and this authorization's fail-closed
requirement), which this proposal will not do.

**Fail-closed statement, exactly as required**: *No autonomous AI reply
may use a personal Writing Twin unless a future, explicit attribution
policy determines which authenticated user's profile is authorised to
represent that reply. Absence of a valid attribution policy means no
personal Writing Twin is applied.* Concretely enforced by: (a) no
`userId` parameter exists on `GatherAiHandoffContextInput` today, so
there is nothing to pass to `retrieveWritingTwinContext` from that path
even if someone tried; (b) `WritingTwinService`'s methods reject a
non-`'user'` `actorType` (§12); (c) no repository method accepts an
`agentId` (§11). Three independent layers, matching this engagement's
consistent defense-in-depth discipline, not one guard that could be
individually forgotten.

**What this phase's design *does* enable**: a future, explicitly
human-invoked feature (e.g. a "draft this reply in my voice" button a
logged-in team member clicks while composing a reply themselves) has a
real `userId` - the authenticated person clicking the button - and can
safely call `retrieveWritingTwinContext(businessId, res.locals.auth.userId,
channelScope)` through an ordinary authenticated route. **That specific,
human-initiated feature is not built in this phase either** (it is not
authorized here), but this design does not block it - it is exactly the
"future, explicit attribution policy" the fail-closed rule anticipates,
because a direct user action *is* an explicit attribution policy (the
clicking user is unambiguously whose voice is being requested), unlike an
autonomous agent reply, which has no such unambiguous mapping.

**Trust handling** (unchanged from W1-B §16, restated for completeness):
Tier A's profile is rendered as trusted, code-synthesized instruction
content by `buildSystemInstruction`'s eventual writing-twin-aware
extension - never `wrapUntrustedData`. Tier B examples, if ever included
directly (a W6 decision, not this phase's), would be wrapped exactly like
every other real-but-not-code-authored content. Tier C never reaches a
prompt under any circumstance - no repository method above (§11) exposes
Tier C to anything but the extraction job's own narrow read.

---

## 15. Full schema-level and integration-level test plan

Extends W1-B §19 (20 behavioral cases) and W2-A §14 (17 schema-constraint
cases) with the cases this proposal's specific changes introduce:

**Schema-level (raw SQL, proving the constraint itself, not application
behavior):**

1. A composite-FK insert with a real `business_id` and a real `user_id`
   who is *not* a member of that business is rejected (proves §1/§2's
   membership-integrity constraint, distinct from W2-A's #17 which only
   proved individual FK validity).
2. Deleting a `business_memberships` row cascades to delete every
   Writing Twin row (all five tables) for that exact `(business_id,
   user_id)` pair, and leaves every other user's/business's rows
   untouched.
3. Inserting a second `is_current = true` `writing_twin_profiles` row
   for the same `(business_id, user_id, channel_scope)` is rejected by
   the partial unique index.
4. Deleting a `writing_twin_style_examples` row cascades to delete its
   `writing_twin_profile_derivations` rows, and no others.
5. A `writing_twin_profiles` row can be inserted with zero associated
   `writing_twin_profile_derivations` rows (the "not yet enough
   evidence" case is representable, though per §3 the service layer
   should not create such a row in practice - the schema itself does not
   forbid it, since forbidding it would require a cross-table CHECK
   Postgres cannot express, so this is a documented service-layer
   responsibility, not a schema one).

**Integration-level (real Postgres, service/repository layer):**

6. `WritingTwinRepository.isProfileStale` returns `true` after one of a
   profile version's derivation examples is deleted, and `false` before.
7. `createProfileVersion` correctly flips the prior `is_current` row to
   `false` and stamps `superseded_at`, atomically with the new row's
   insert - a forced mid-transaction failure leaves the *old* version
   still current, never a state with zero or two current versions.
8. `deleteAllForUser` removes all five tables' rows for the exact pair
   and leaves every other user's (including another user in the same
   business) data untouched - re-verified with the fifth table included,
   extending W2-A's #8.
9. `countStyleExamples`+`addStyleExample`'s cap enforcement holds under
   concurrent addition (two simultaneous adds when one slot remains
   never both succeed).
10. `listUnprocessedRawEvents` never returns a row past `expires_at`,
    confirmed with a row whose `expires_at` is in the past but which the
    sweep has not yet reached (proves the "ineligible even if not yet
    swept" property from §5, not just "eventually deleted").
11. `WritingTwinService`'s user-facing methods reject a
    `BusinessExecutionContext` with `actorType !== 'user'`.
12. `WritingTwinRepository`'s public method signatures contain no
    parameter named `agentId` or `identityId` anywhere (a
    structural/type-level check, mirroring D4-B's tool-registry
    verification) - re-confirmed against this proposal's actual
    interface, not just W2-A's.
13. `retrieveWritingTwinContext` is never called from
    `aiContextGathererService.ts`'s WhatsApp-agent-reply path in this
    phase's implementation - confirmed the same way D4-B confirmed
    `retrieveAiDocumentContext`'s single call site, applied here to prove
    a call site does *not* yet exist where it must not.
14. `final_text`/`ai_baseline_text` are stored as an `EncryptedEnvelope`
    (not plaintext) in the database - a raw `SELECT` against the table in
    a test asserts the column value is not human-readable, mirroring how
    `whatsapp_messages.text_content` encryption is presumably already
    verified in this codebase's existing test suite.
15. Historical backfill never runs as a side effect of
    `setLearningEnabled(true)` alone - a test asserts no raw events are
    created for pre-existing historical messages unless
    `requestHistoricalBackfill` was separately called.

---

## 16. Rollback strategy

Unchanged in substance from W2-A §13, extended for the fifth table: a
plain `DROP TABLE` set (five tables, in FK-dependency order:
`writing_twin_profile_derivations` first, since it references the other
two; then `writing_twin_profiles`, `writing_twin_style_examples`,
`writing_twin_raw_events`, `writing_twin_settings` in any order, since
none of those four reference each other). No other feature references
any of these five tables, so rollback has zero blast radius outside this
feature - confirmed by construction, since this proposal introduces no
new column on any pre-existing table (§10) and no other service is
proposed to import from `writingTwinRepository.ts`/`writingTwinService.ts`.

Because Tier C's retention is bounded (§5) and no cache exists (§4), an
emergency full rollback at any point loses at most: the current Tier
A/B profile/examples for every user who has one (recoverable only by
re-learning, not catastrophic data loss of anything the business itself
depended on to operate), and at most ~60 days of unprocessed Tier C
material - never a large, irreplaceable, or business-critical archive,
by the same deliberate design choice W1-B and W2-A already established.

---

## Final requirement: proof the Writing Twin cannot become a shared business AI profile

Required to be explicit, so it is stated as a direct claim with its
supporting mechanism, not left implicit in the rest of the document:

**Claim**: no code path in this proposal's design can cause one user's
Writing Twin to be applied to, inherited by, or blended with another
user's identity, another user's reply, or a business-wide "house style,"
under any circumstance, without a separately designed and separately
authorized feature.

**Supporting mechanisms, all independent of each other**:

1. Every table's primary scoping key is `(business_id, user_id)`, never
   `business_id` alone - there is no table, view, or aggregate in this
   design keyed only by business (§5 of W2-A, unchanged, re-affirmed
   here).
2. The composite FK (§1/§2) ties every row to one specific real
   membership - one specific person, in one specific business - not a
   business-level concept a membership could be substituted for.
3. `WritingTwinRepository` has no method that aggregates across users
   within a business (no `getBusinessStyleProfile(businessId)`, no
   "average" or "blended" signal computation across multiple users'
   Tier A rows) - the schema and repository interface simply do not
   provide the shape a shared profile would need, so building one would
   require new tables and new methods, not a parameter change to
   existing ones.
4. The AI integration boundary (§14) requires a real, specific `userId`
   to retrieve anything - there is no "give me the business's style"
   call shape, and the one path that has no `userId` available at all
   (the autonomous WhatsApp agent reply) is the one path this proposal
   explicitly does not wire up, precisely because it has no single
   user to attribute to.
5. `WritingTwinService`'s `actorType === 'user'` check (§12) means even
   an authenticated *system* or *AI* actor - which could, in principle,
   have a real `businessId` and act "on behalf of" the business generally
   - is rejected from every settings/retrieval method, not just the ones
   an obviously-risky caller might use.

**What would have to change for a shared profile to exist**: a new table
(e.g. `writing_twin_business_profiles`, keyed by `business_id` alone), a
new repository method family, a new explicit UI/API surface for creating
one, and a new, separate authorization decision about who may create,
view, or apply it - none of which this proposal creates, references, or
leaves an accidental path toward. The absence of that surface is the
proof, in the same sense D4-B proved Gemini "cannot access business
documents" by showing no import existed - here, no shared-profile
capability exists because nothing in this design has the shape one would
require.

---

No migration and no code changes were made in this phase.
