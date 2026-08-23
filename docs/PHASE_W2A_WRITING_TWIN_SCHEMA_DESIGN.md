# Phase W2-A: Writing Twin Schema Design

**Status: design only. No migration, no implementation in this phase.**
Builds on W1-A (`PHASE_W1A_WRITING_TWIN_ATTRIBUTION_AUDIT.md`) and W1-B
(`PHASE_W1B_WRITING_TWIN_ARCHITECTURE_PROPOSAL.md`), and incorporates every
clarification from their approval: the cache-invalidation-on-deletion
requirement, the schema-bound (never free-form) Tier A generation
invariant, and the fail-closed autonomous-AI-attribution rule. This
document produces the exact table design; W2-B will turn it into an
approved implementation proposal; only after that does any migration or
table get created.

---

## 1-4. Live schema re-audit

Re-confirmed directly against the current repository state (not assumed
from W1-A's write-up):

- Latest migration on disk: `068_business_document_chunks.sql` - the next
  Writing Twin migration would be `069_...`. No migrations landed between
  W1-A and now.
- **`ON DELETE` convention, surveyed across every migration**: a row's
  *own owning* FK (`business_id` on a business-owned row, `user_id` on a
  `user_preferences`-shaped row) is always `ON DELETE CASCADE`. An
  *attribution/reference* FK on someone else's row (`created_by`,
  `approved_by`, `drafted_by_agent_id`, `crm_contact_id` on an unrelated
  table) is always `ON DELETE SET NULL`. This distinction matters
  directly for Writing Twin design (§5): every Writing Twin table's
  `business_id`/`user_id` are *ownership* FKs (the row cannot meaningfully
  exist without them) and must be `CASCADE`, never `SET NULL`.
- **`user_preferences`** (migration `035_create_auth_foundation.sql:78`),
  re-inspected in full:
  ```sql
  CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'sleek',
    ...
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
  Single-tenant-per-user shape (`user_id` alone as PK) - **not directly
  reusable for Writing Twin settings**, because Writing Twin must be
  scoped by `business_id` *and* `user_id` together (W1-B §1/§3's Rule 1;
  a user in two businesses gets two independent Writing Twins). The
  directly reusable shape is instead **`business_memberships`**
  (`035_create_auth_foundation.sql:37`):
  ```sql
  CREATE TABLE business_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ...
    UNIQUE (business_id, user_id)
  );
  CREATE INDEX idx_business_memberships_user ON business_memberships (user_id);
  CREATE INDEX idx_business_memberships_business ON business_memberships (business_id);
  ```
  This composite-ownership shape - surrogate `id` PK, `UNIQUE(business_id,
  user_id)`, one index per FK direction - is what every Writing Twin
  table in §5 follows.
- **JSONB usage audit**: every existing `JSONB` column in this codebase
  (`whatsapp_chats.metadata`, `whatsapp_messages.raw_metadata`,
  `ai_agents.allowed_tools`/`knowledge_sources`, `crm_contacts.tags`/
  `custom_fields`, etc.) is genuinely free-form, uninspected-by-Postgres
  metadata - **none of them carry a `CHECK` constraint validating their
  shape**. This is directly relevant to the user's new Tier A invariant
  (schema-bound, never arbitrary free-form output): **this codebase has
  no existing precedent for a DB-validated structured-JSON column**, so
  Tier A's design (§5.2) deliberately does **not** follow the JSONB
  convention - it uses explicit, individually `CHECK`-constrained typed
  columns instead, which is both the strongest available enforcement and
  consistent with this codebase's dominant convention for anything with
  real structure (`business_documents.status`, `ai_agents.category`, etc.
  are always typed/enum columns, never JSON).
- **`withTransaction`** (`src/db/transaction.ts`) and repositories
  re-instantiated with a transactional `PoolClient` inside the callback
  (`whatsappMessagePersistenceService.ts`'s established pattern) is the
  reusable primitive for §8's deletion transaction.
- **The narrow-then-widen `CHECK` pattern** (`ALTER TABLE ... DROP
  CONSTRAINT ...; ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`), used
  9x for `security_audit_logs.event_type` and again for D1→D2's
  `business_documents`/`business_document_versions` status widening, is
  reused for every enum-shaped column below.

---

## 5. Exact Writing Twin table design

Four tables, following the `business_memberships` composite-ownership
shape from §1-4. Migration number `069` (next available); table/column
names below are the actual proposed names, not placeholders - W2-B may
still adjust naming for consistency review, but this is the concrete
design being proposed, not a sketch.

### 5.1 `writing_twin_settings`

```sql
CREATE TABLE writing_twin_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  learning_enabled BOOLEAN NOT NULL DEFAULT false,
  historical_backfill_requested_at TIMESTAMPTZ,
  historical_backfill_completed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, user_id)
);

CREATE INDEX idx_writing_twin_settings_user ON writing_twin_settings (user_id);
-- No separate business-only index: this table is never listed "all
-- settings rows for a business" in any proposed access pattern (unlike
-- business_memberships, which genuinely needs "list members of a
-- business") - the UNIQUE(business_id, user_id) index already serves
-- every real lookup (business_id, user_id) together.
```

`learning_enabled` defaults `false` - fail-closed, matching D1's four
capability-flag precedent exactly. A row not existing yet (before a user
ever visits Writing Twin settings) is equivalent to `learning_enabled =
false` - the service layer (W2-B) must treat "no settings row" and
"settings row with `learning_enabled = false`" identically, never
requiring a row to exist before defaulting safely closed.

### 5.2 `writing_twin_profiles` (Tier A - schema-bound aggregate signals)

This is where the user's new invariant is structurally enforced: **every
signal is an individually `CHECK`-constrained, bounded column - never a
free-form text field, never unconstrained JSON.**

```sql
CREATE TABLE writing_twin_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_scope TEXT NOT NULL CHECK (channel_scope IN ('global', 'email', 'whatsapp')),

  -- Every signal below is a bounded enum/bucket, never free text -
  -- the allow-listed schema the user's invariant requires. NULL means
  -- "not yet enough signal to determine this," never "unknown/blank
  -- string" - honestly absent, not fabricated as a default bucket.
  preferred_tone TEXT CHECK (preferred_tone IN ('concise', 'balanced', 'detailed')),
  formality TEXT CHECK (formality IN ('casual', 'neutral', 'formal')),
  greeting_style TEXT CHECK (greeting_style IN ('none', 'minimal', 'warm')),
  sign_off_style TEXT CHECK (sign_off_style IN ('none', 'minimal', 'warm')),
  avg_sentence_length_bucket TEXT CHECK (avg_sentence_length_bucket IN ('short', 'medium', 'long')),
  punctuation_emphasis TEXT CHECK (punctuation_emphasis IN ('low', 'moderate', 'high')),
  emoji_frequency TEXT CHECK (emoji_frequency IN ('none', 'low', 'moderate', 'high')),
  directness TEXT CHECK (directness IN ('direct', 'balanced', 'hedged')),
  question_pattern TEXT CHECK (question_pattern IN ('rare', 'occasional', 'frequent')),

  -- Small, individually length-capped lists, not unbounded arrays -
  -- each element bounded, and the array itself capped at a fixed size
  -- via a CHECK, not merely convention.
  common_phrases TEXT[] CHECK (array_length(common_phrases, 1) IS NULL OR array_length(common_phrases, 1) <= 8),
  common_sign_offs TEXT[] CHECK (array_length(common_sign_offs, 1) IS NULL OR array_length(common_sign_offs, 1) <= 5),

  example_count INTEGER NOT NULL DEFAULT 0,
  last_recomputed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, user_id, channel_scope)
);

CREATE INDEX idx_writing_twin_profiles_user ON writing_twin_profiles (business_id, user_id);

-- Bounds each element of common_phrases/common_sign_offs to a real
-- length limit (Postgres CHECK cannot directly bound array-element
-- length inline; enforced via a helper predicate over unnest).
ALTER TABLE writing_twin_profiles ADD CONSTRAINT writing_twin_profiles_phrase_length_check
  CHECK (NOT EXISTS (SELECT 1 FROM unnest(common_phrases) AS p WHERE length(p) > 80));
ALTER TABLE writing_twin_profiles ADD CONSTRAINT writing_twin_profiles_signoff_length_check
  CHECK (NOT EXISTS (SELECT 1 FROM unnest(common_sign_offs) AS s WHERE length(s) > 40));
```

This is the structural realization of the user's requirement: *"the
system should produce something conceptually like: preferred tone:
concise; greeting style: optional; average sentence length: short; emoji
frequency: low. It should not generate arbitrary free-form text."* Every
column here is exactly that shape - a bounded enum or a bounded array of
bounded strings, database-enforced, not merely a documented convention
the extraction code is trusted to follow. A W3 extraction job that tried
to write an arbitrary free-form sentence into `preferred_tone` would fail
at the database, not silently succeed.

`common_phrases`/`common_sign_offs` are the one place short verbatim
fragments live in Tier A (a handful of literal phrases like "Thanks so
much!" are inherently what "common phrases" means) - each individually
capped at 80/40 characters and the whole array capped at 8/5 elements,
so even this bounded exception cannot grow into a real transcript.

### 5.3 `writing_twin_style_examples` (Tier B - bounded curated examples)

```sql
CREATE TABLE writing_twin_style_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_scope TEXT NOT NULL CHECK (channel_scope IN ('global', 'email', 'whatsapp')),

  source_provenance TEXT NOT NULL CHECK (source_provenance IN
    ('human_authored', 'ai_generated_then_edited', 'explicitly_approved')),
  -- Deliberately excludes 'ai_generated_unchanged' and
  -- 'unknown_or_ambiguous' from the CHECK itself (not merely from
  -- application logic) - a row with either value can never be inserted,
  -- matching W1-B §4's rule at the strongest possible enforcement point.

  example_text TEXT NOT NULL CHECK (length(example_text) <= 2000),
  source_table TEXT NOT NULL CHECK (source_table IN ('email_messages', 'whatsapp_outbound_messages')),
  source_row_id UUID NOT NULL,

  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, user_id, channel_scope, source_table, source_row_id)
  -- Prevents the same source message from ever being captured twice as
  -- a separate example for the same user/channel.
);

CREATE INDEX idx_writing_twin_style_examples_user ON writing_twin_style_examples (business_id, user_id, channel_scope, added_at DESC);
```

`source_table`/`source_row_id` are a soft reference (no FK - the two
possible source tables differ, so a single polymorphic FK isn't directly
expressible in Postgres without a second lookup table this design does
not need). No `ON DELETE` behavior is needed for it precisely because it
is soft: if the original `email_messages` row is later deleted for an
unrelated reason, the style example - already a copy of the text at
capture time - is unaffected, which is correct (the example was
approved/authored once; its later fate is independent of the twin).

**Cap enforcement**: not a DB `CHECK` (Postgres cannot cheaply enforce
"at most N rows matching a condition" as a table constraint) - enforced
the same way as D1's `max_business_documents`, via a
`EntitlementService`-style count-check in the service layer before
insert (W2-B's job to implement; this document specifies the requirement
and the precedent to follow, not new DB mechanism).

### 5.4 `writing_twin_raw_events` (Tier C - short-lived raw material)

```sql
CREATE TABLE writing_twin_raw_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_scope TEXT NOT NULL CHECK (channel_scope IN ('email', 'whatsapp')),
  -- No 'global' here - a raw event is always channel-specific at
  -- capture time; 'global' only exists as a derived Tier A aggregation.

  provenance TEXT NOT NULL CHECK (provenance IN
    ('human_authored', 'ai_generated_then_edited', 'explicitly_approved')),

  source_table TEXT NOT NULL CHECK (source_table IN ('email_messages', 'whatsapp_outbound_messages')),
  source_row_id UUID NOT NULL,

  ai_baseline_text TEXT CHECK (ai_baseline_text IS NULL OR length(ai_baseline_text) <= 5000),
  final_text TEXT NOT NULL CHECK (length(final_text) <= 5000),

  processed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A correction record (ai_generated_then_edited) must carry a
  -- baseline to diff against; any other provenance must not carry one
  -- it would have no honest source for.
  CONSTRAINT writing_twin_raw_events_baseline_matches_provenance CHECK (
    (provenance = 'ai_generated_then_edited' AND ai_baseline_text IS NOT NULL)
    OR (provenance != 'ai_generated_then_edited' AND ai_baseline_text IS NULL)
  )
);

CREATE INDEX idx_writing_twin_raw_events_user ON writing_twin_raw_events (business_id, user_id, channel_scope);
-- The index the expiry sweep actually scans (§7) - unprocessed-or-not,
-- purely by time, matching the existing pending/stale-job partial-index
-- convention (whatsapp_outbound_messages_pending_idx,
-- whatsapp_sync_jobs' equivalent).
CREATE INDEX idx_writing_twin_raw_events_expiry ON writing_twin_raw_events (expires_at);
```

---

## 6. Provenance constraints

Enforced at three layers, matching this codebase's established
defense-in-depth discipline (Phase 0.1's binding principle: earlier
authorization is valuable, but the data-access layer should also enforce
the same boundary):

1. **CHECK constraint** (§5.3/§5.4): `source_provenance`/`provenance` can
   only ever be one of the three learning-eligible values - the two
   ineligible values (`ai_generated_unchanged`, `unknown_or_ambiguous`)
   are not merely discouraged, they are **impossible to insert**, the
   strongest layer.
2. **Repository layer** (W2-B): every insert method takes an explicit,
   typed `provenance` parameter from a TypeScript union type mirroring
   the CHECK - never a raw string threaded from a caller, so a
   compile-time typo cannot silently produce a value the CHECK would
   have caught only at runtime.
3. **Extraction/collection service layer** (W3): the actual
   classification logic - "is this row genuinely `human_authored`?" -
   lives here, and must derive its answer only from the structural
   source-table facts W1-A documented (`drafted_by_agent_id IS NULL` for
   email, a real per-send `user_id` match for post-W5 WhatsApp) - never
   from a heuristic guess. This document does not specify W3's
   extraction algorithm (out of scope for schema design), only that the
   schema's CHECK constraint is the backstop if it ever gets this wrong.

---

## 7. Tier C expiry enforcement

**Structural, not caller-dependent**, per W1-B §11 and the user's
explicit "must be enforced structurally" requirement:

- `expires_at` is `NOT NULL` and computed **at insert time** (a fixed
  offset from `created_at`, e.g. `created_at + interval '60 days'` -
  the exact window is a W2-B open decision per W1-B §21, but the
  mechanism - computed once, at write time, never recomputed or extended
  later - is fixed here).
- A scheduled sweep (new W3 worker, mirroring the existing stale-job
  sweep pattern already used for `whatsapp_outbound_messages_pending_idx`/
  sync-job/call-timeout reconciliation) runs
  `DELETE FROM writing_twin_raw_events WHERE expires_at < now()` on an
  interval, using `idx_writing_twin_raw_events_expiry` - a genuinely
  cheap, indexed delete, not a full scan.
- **No code path may read `expires_at` to decide whether to *use* a row
  for anything other than the sweep's own deletion** - a row past its
  expiry that the sweep hasn't yet reached must still never be returned
  by any query other than the sweep's. W2-B's repository methods that
  read Tier C for processing (W3) must therefore also filter
  `WHERE expires_at > now()`, so an about-to-be-swept row is never
  processed in the gap between expiry and the next sweep run - belt and
  braces, matching this codebase's defense-in-depth discipline again.

---

## 8. Deletion transaction semantics

"Delete Writing Twin" is one `withTransaction` call deleting from all
four tables for the exact `(business_id, user_id)` pair, in a fixed order
(children before the settings row is not actually required here since
none of these four tables reference each other by FK - they are siblings,
not a hierarchy - but a fixed order still matters for readability and for
the audit trail):

```
withTransaction(async (client) => {
  const repo = new WritingTwinRepository(client); // same re-instantiate-with-transactional-client pattern as whatsappMessagePersistenceService.ts
  await repo.deleteRawEvents(businessId, userId);       // Tier C
  await repo.deleteStyleExamples(businessId, userId);    // Tier B
  await repo.deleteProfiles(businessId, userId);         // Tier A
  await repo.deleteSettings(businessId, userId);         // settings row itself
});
```

Each `deleteX` method's `WHERE` clause is `business_id = $1 AND user_id =
$2` - the same structural boundary as every read method, so a deletion
bug cannot accidentally widen to "delete this user's data in every
business" or "delete every user's data in this business." All four
deletes happen in one transaction so a mid-failure (e.g. a DB error after
Tier C/B are gone but before Tier A/settings) cannot leave the twin in a
partially-deleted, inconsistent state - either the whole deletion commits
or none of it does.

**Cache invalidation** (the user's new requirement): no cache exists yet
in this codebase's Writing Twin path (none is proposed by W1-B or this
document - W2-B's retrieval service, per D4-B's established pattern, is a
direct-to-Postgres read on every call, exactly like
`aiDocumentRetrievalService`/`knowledgeBaseSearchService` today, neither
of which caches). This document records the requirement for the future
regardless: **if any caching layer is introduced later (in-memory,
Redis, or otherwise - this codebase's one precedent is
`EncryptionService`'s Redis DEK cache, `src/security/encryption/keyCache.ts`),
the deletion transaction must invalidate that cache's entry for the exact
`(business_id, user_id)` key as part of the same deletion flow - not as a
separately-scheduled or best-effort cleanup.** Concretely: the deletion
service method's contract must include "no cached Writing Twin data for
this user survives this call," and any future cache-introducing change
must update this method, not bolt on cache invalidation elsewhere. This
requirement is recorded here so it is not lost by the time a cache is
actually proposed.

---

## 9. Indexes and uniqueness

Summarized from §5, each justified by an actual query it serves (not
speculative):

| Table | Unique constraint | Index | Query it serves |
|---|---|---|---|
| `writing_twin_settings` | `(business_id, user_id)` | `(user_id)` | "Is learning on for this user in this business?" (unique lookup); "does this user have Writing Twin settings anywhere?" (rare, e.g. account-wide review) |
| `writing_twin_profiles` | `(business_id, user_id, channel_scope)` | `(business_id, user_id)` | Retrieval (§15 of W1-B) always fetches all channel rows for a user in one query, then applies the fallback hierarchy in code |
| `writing_twin_style_examples` | `(business_id, user_id, channel_scope, source_table, source_row_id)` | `(business_id, user_id, channel_scope, added_at DESC)` | Listing a user's examples for a channel, newest first (for cap-enforcement/rotation, §10 of W1-B) |
| `writing_twin_raw_events` | none beyond PK | `(business_id, user_id, channel_scope)`, `(expires_at)` | Processing job pulls a user's unprocessed events per channel; sweep job pulls everything past expiry, business-agnostically (deletion by time doesn't need tenant scoping - it's already an unconditional delete) |

No table has a unique constraint on `id` alone beyond the implicit PK
one - every real lookup this design anticipates goes through the
`(business_id, user_id, ...)` shape, matching D3-C's dedicated-method
discipline: there is no generically-keyed lookup method to misuse.

---

## 10. Cross-tenant and cross-user repository boundaries

One `WritingTwinRepository` class (matching `BusinessDocumentRepository`'s
established shape - one repository per feature, not one per table),
exposing only narrow, purpose-named methods, never a generic
`findById(id)`:

```ts
class WritingTwinRepository {
  // Settings
  async getSettings(businessId: string, userId: string): Promise<WritingTwinSettings | null>
  async setLearningEnabled(businessId: string, userId: string, enabled: boolean): Promise<void>
  async recordBackfillRequested(businessId: string, userId: string): Promise<void>
  async recordBackfillCompleted(businessId: string, userId: string): Promise<void>

  // Tier A
  async getProfile(businessId: string, userId: string, channelScope: ChannelScope): Promise<WritingTwinProfile | null>
  async getAllProfilesForUser(businessId: string, userId: string): Promise<WritingTwinProfile[]> // backs the fallback hierarchy
  async upsertProfile(businessId: string, userId: string, channelScope: ChannelScope, signals: WritingTwinSignals): Promise<void>

  // Tier B
  async countStyleExamples(businessId: string, userId: string, channelScope: ChannelScope): Promise<number> // for the cap check
  async listStyleExamples(businessId: string, userId: string, channelScope: ChannelScope, limit: number): Promise<WritingTwinStyleExample[]>
  async addStyleExample(businessId: string, userId: string, ...): Promise<WritingTwinStyleExample>
  async deleteOldestStyleExample(businessId: string, userId: string, channelScope: ChannelScope): Promise<void> // rotation on cap-overflow

  // Tier C
  async recordRawEvent(businessId: string, userId: string, ...): Promise<void>
  async listUnprocessedRawEvents(businessId: string, userId: string, channelScope: ChannelScope): Promise<WritingTwinRawEvent[]> // filters expires_at > now(), per §7
  async markRawEventProcessed(businessId: string, userId: string, id: string): Promise<void>
  async sweepExpiredRawEvents(): Promise<number> // the only method with no (businessId, userId) parameter - deliberately, since a time-based sweep is not a per-tenant read

  // Deletion (§8)
  async deleteAllForUser(businessId: string, userId: string): Promise<void> // wraps the four deletes in one withTransaction call
  async resetProfile(businessId: string, userId: string): Promise<void> // Tier A + B only, per W1-B §7's distinction between reset and delete
}
```

**No method accepts a bare `id` for any of the four tables without also
requiring `businessId`/`userId` in its signature**, except
`sweepExpiredRawEvents` (time-based, tenant-agnostic by design, matching
the existing stale-job sweep precedent which is also unconditional
across tenants) and the internal use of a row's own `id` *within* a
method that already validated `businessId`/`userId` first (e.g.
`deleteOldestStyleExample` selects the oldest row via the tenant-scoped
query, then deletes by that row's `id` - the `id` never arrives from an
external caller). This mirrors D3-C's Option A discipline exactly: no
single generic method exists that a future caller could misuse to skip
the tenant/user boundary.

**AI-agent attribution fail-closed rule** (the user's new requirement):
`WritingTwinRepository` and its consuming retrieval service (W2-B/W6)
expose **no method that accepts an `agentId` in place of a `userId`**.
There is no `getProfileForAgent(businessId, agentId)` method, and none
should ever be added without a separately authorized attribution policy
existing first (W1-B §15's open decision, now hardened by this rule): the
absence of such a method is itself the fail-closed enforcement - an
autonomous AI-agent reply path (which only ever has an `agentId`, never a
`userId`, per W1-A's own finding that agent replies are not human-attributed)
has no way to call into Writing Twin retrieval at all today, and adding
one requires a new, explicit, separately-reviewed method - not a
parameter substitution on an existing one.

---

## 11. How aggregate signals remain schema-bound

Already the core of §5.2's design, restated as the explicit answer to
this specific item: every Tier A column is `CHECK`-constrained to a fixed
enum or a bounded/length-capped array - there is no `TEXT` column in
`writing_twin_profiles` without either a `CHECK (... IN (...))` or an
explicit `CHECK (length(...) <= N)` alongside an array-size cap. A W3
extraction job cannot write anything the schema doesn't already
enumerate, regardless of what an LLM-based extraction step (if W3 chooses
to use one) might otherwise produce - the CHECK constraint is the actual
enforcement boundary, not the extraction code's own discipline. This
directly satisfies the user's stated invariant: *"the signal-extraction
pipeline must produce structured fields from an allow-listed schema, with
bounded values and bounded lengths."*

---

## 12. Every future cache that could survive deletion

Audited now, per the user's explicit request, even though none exists
yet:

- **None currently exists** for any Writing Twin data - none is created
  by this document, and W2-B's proposed retrieval service (mirroring
  D4-B's `retrieveAiDocumentContext`/`searchKnowledgeBase` pattern) reads
  Postgres directly on every call, with no caching layer.
- **The one existing precedent in this codebase**,
  `src/security/encryption/keyCache.ts` (the Redis DEK cache), is noted
  here as the pattern any future Writing Twin cache would most likely
  follow if one is ever added (e.g. for latency, if profile retrieval
  becomes a hot path) - and per §8, any such addition must extend the
  deletion transaction to invalidate it in the same call, not as a
  follow-up.
- **HTTP/CDN caching**: Writing Twin data is never served through any
  public or cacheable HTTP response path (it only ever flows into a
  server-side prompt-construction step, never returned to a browser as
  cacheable content), so no CDN/browser-cache concern applies here the
  way it might for, say, a public asset.
- **In-process module-level state**: this codebase's one precedent for
  that shape is `geminiCircuitBreaker` (a module-level singleton) - but
  that holds no per-user data, only aggregate failure-rate state, so it
  is not an analogous risk. No Writing Twin design proposed here
  introduces any module-level singleton holding per-user data.

This section exists so that if/when a cache is proposed for this feature
in a future phase, that phase's author (human or Claude) has this
document to check against, rather than rediscovering the requirement.

---

## 13. Migration additivity

The eventual W2-B migration (still not created in this phase) is
additive-only:

- Four new tables (§5), zero `ALTER TABLE` on any existing table - unlike
  W5's WhatsApp attribution work (which does require one additive,
  nullable column on `whatsapp_outbound_messages`, already scoped
  separately in W1-B §18 and explicitly not part of this migration).
- No existing table's constraints, indexes, or data are touched.
- Every enum-shaped `CHECK` in §5 follows the narrow-then-widen
  convention (§1-4) - e.g. `channel_scope` starts at exactly
  `('global', 'email', 'whatsapp')`, the three values this design
  actually needs today; if a future channel is ever added, the existing
  `DROP CONSTRAINT`/`ADD CONSTRAINT` pattern widens it without any data
  migration, exactly as D1→D2 did for `business_documents.status`.
- Rollback of the eventual migration is a plain `DROP TABLE` (in reverse
  dependency order, though as noted in §8 these four tables have no FK
  relationships to each other, only to `businesses`/`users`) with no
  impact on any other feature - confirmed by construction, since nothing
  outside this feature is proposed to reference any of these four tables.

---

## 14. Adversarial test plan

Extends W1-B §19's 20-case matrix with schema-level cases specific to
what this document adds - the enforcement mechanism, not just the
behavior:

1. Inserting a `writing_twin_style_examples` row with
   `source_provenance = 'ai_generated_unchanged'` is rejected by the
   `CHECK` constraint itself (a raw SQL-level test, not just a
   service-level one) - proving the boundary is real even if a future
   service-layer bug tried to bypass it.
2. Same for `source_provenance = 'unknown_or_ambiguous'`.
3. Inserting a `writing_twin_raw_events` row with
   `provenance = 'ai_generated_then_edited'` and `ai_baseline_text IS
   NULL` is rejected by `writing_twin_raw_events_baseline_matches_provenance`.
4. Inserting a `writing_twin_raw_events` row with
   `provenance = 'human_authored'` and a non-null `ai_baseline_text` is
   also rejected by the same constraint (the inverse case).
5. Inserting a `writing_twin_profiles` row with an out-of-enum
   `preferred_tone` value (e.g. `'sarcastic'`) is rejected by its
   `CHECK`.
6. Inserting a `common_phrases` array with a 9th element is rejected by
   `array_length(...) <= 8`.
7. Inserting a `common_phrases` element longer than 80 characters is
   rejected by `writing_twin_profiles_phrase_length_check`.
8. `deleteAllForUser(businessId, userId)` removes all four tables' rows
   for that exact pair and leaves every other user's rows (including
   another user in the same business, and the same user in a different
   business) completely untouched - re-verified as a real Postgres
   integration test, not asserted from the design alone.
9. `deleteAllForUser` either fully commits or fully rolls back - a forced
   failure injected between two of the four deletes (e.g. a mocked
   error) leaves zero rows deleted, not a partial state.
10. `resetProfile` clears Tier A/B rows but leaves the
    `writing_twin_settings` row (and its `learning_enabled` value)
    unchanged.
11. `sweepExpiredRawEvents` deletes a row with `expires_at` in the past
    regardless of `processed_at` (both null and non-null cases).
12. `sweepExpiredRawEvents` does not delete a row with `expires_at` in
    the future.
13. `listUnprocessedRawEvents` never returns a row past its `expires_at`,
    even in the window before the next sweep run.
14. No `WritingTwinRepository` method other than `sweepExpiredRawEvents`
    can be called without both `businessId` and `userId` - a
    TypeScript-level check (the method signatures themselves), not just
    a runtime test.
15. `UNIQUE (business_id, user_id, channel_scope, source_table,
    source_row_id)` on `writing_twin_style_examples` rejects a second
    insert of the same source message for the same user/channel.
16. `UNIQUE (business_id, user_id, channel_scope)` on
    `writing_twin_profiles` rejects a second profile row for the same
    triple (an upsert must use `ON CONFLICT`, not a bare insert).
17. No method on `WritingTwinRepository` accepts an `agentId` parameter -
    confirmed by inspecting the class's public method signatures (a
    structural/grep-style check mirroring D4-B's "confirm no new tool
    exists" verification), proving the fail-closed AI-agent-attribution
    rule (§10) holds by omission, not by a runtime guard that could be
    forgotten in a future addition.

---

## Summary: what changes and what does not

**Changes proposed in this document (not yet implemented)**: four new
tables, one repository class with narrowly-scoped methods, no changes to
any existing table.

**What this phase (W2-A) does not do**: no migration file is created, no
repository code is written, no test is run - this document is the design
those things will be built from in W2-B, per the phase gate the user
required.

No migration, implementation, or code changes were made in this phase.
