# Phase B — Consolidated Architecture & Implementation Plan
### Knowledge Base 2.0 / Secure Business Documents + Personal AI Writing Twin

**Status: ARCHITECTURE DOCUMENT ONLY. No migration, no document tables, no
Writing Twin tables, no Google Drive/Dropbox connection, no document
upload, no parsing, no style learning, no production AI prompt change,
no unrelated refactor has been made.** Repository: WhatchatAI. Branch:
`openclaw-cell-runtime`. Security-hardening checkpoint this phase builds
on: `2061228` (Phase 0.1). Verified test baseline at the start of this
phase: 688/688.

Every claim below is labeled `EXISTING AND VERIFIED`, `PROPOSED`,
`DEFERRED`, or `UNKNOWN / REQUIRES VERIFICATION`. An `EXISTING AND
VERIFIED` claim cites a real file:line and, where a test proves it, a
real test file. Nothing here is implemented unless labeled as such.

---

## 0. How this document relates to Phase 2C

`docs/PHASE_2C_DOCUMENT_ARCHITECTURE_PROPOSAL.md` (708 lines, prior
phase) already designed the document system in detail and is not
reproduced here in full. This document: **(a)** resolves every open
decision Phase 2C left for review (§1 below), **(b)** re-verifies Phase
2C's design against a fresh, direct repository audit rather than
trusting the old document's own citations, **(c)** designs the Writing
Twin system from scratch, and **(d)** produces one merged implementation
plan, threat model, and test matrix covering both systems plus their
integration point (a future combined AI context). Where Phase 2C's
original table design is unchanged, this document says so and gives a
condensed schema table rather than repeating 700 lines of prose.

---

## 1. Required review of Phase 2C's open decisions

Per the master directive, none of these are silently resolved — each
gets options, security/operational implications, a recommendation, and
whether it blocks implementation.

### 1.1 Classification model: independent booleans vs. enum + booleans

- **Options:** (A) four independent booleans (`ai_retrievable`,
  `ai_sendable`, `customer_visible`, `human_only`) as Phase 2C proposed;
  (B) a `visibility` enum (`INTERNAL`/`CUSTOMER_VISIBLE`) plus the three
  capability booleans.
- **Security implications:** identical — both express the same state
  space, and the two CHECK constraints Phase 2C already specified
  (`NOT (human_only AND (ai_retrievable OR ai_sendable))`, `NOT
  (ai_sendable AND NOT ai_retrievable)`) apply equally to either.
- **Operational implications:** (A) is one fewer join/enum to reason
  about when writing a repository query (`WHERE ai_retrievable = true`
  vs. `WHERE visibility = 'CUSTOMER_VISIBLE' OR ...`); (B) reads slightly
  more self-documenting in an admin UI dropdown.
- **Recommendation: (A), independent booleans.** Matches the pattern this
  codebase already uses for boolean capability flags elsewhere
  (`whatsapp_accounts`-style status flags), and every default is fail
  closed (all four `false` on creation) regardless of which option is
  picked.
- **Blocks implementation?** No.

### 1.2 `business_id` denormalization: trust app-layer vs. add a consistency trigger/CHECK

- **Options:** (A) denormalize `business_id` onto every document/chunk/
  storage table, set once at insert from the authenticated context,
  trust application code to keep it consistent with the parent row
  (Phase 2C's proposed default); (B) same denormalization, plus a
  Postgres trigger or CHECK that verifies the child's `business_id`
  matches the parent's on every write.
- **Security implications:** (A) is exactly the existing, already-proven
  pattern (`whatsapp_media` denormalizes `business_id` the same way
  today, `src/repositories/whatsappMediaRepository.ts`, confirmed in the
  Phase 1 audit) with zero adversarial findings against it across three
  security-hardening phases. (B) adds a second, independent enforcement
  layer, but the failure mode it catches (application code inserting a
  child row with a `business_id` that doesn't match its parent) is a
  *bug*, not a cross-tenant *attack path* — an attacker never gets to
  choose `business_id` at all (§3, trusted identity rule), so this isn't
  closing an exploitable gap, it's a defensive assertion against a coding
  mistake.
- **Operational implications:** (B) adds real migration/trigger
  complexity for every document table, and a trigger failure mode of its
  own to reason about (what happens to a bulk backfill or a parent-swap
  operation).
- **Recommendation: (A) now; add (B) only if a Phase B adversarial test
  in §7 below finds a real gap.** This mirrors Phase 2C's own
  recommendation and this repo's existing precedent.
- **Blocks implementation?** No.

### 1.3 Chunk-text search vs. field-level encryption — **now resolved, was blocking, is no longer**

This was flagged in Phase 2C as "requires investigation before the
migration is written." That investigation happened in this phase, and
the answer changes the recommendation.

**What was verified (real evidence, not inferred):**

`src/db/migrations/007_create_whatsapp_messages.sql:54` creates
```sql
CREATE INDEX ... ON whatsapp_messages USING gin (to_tsvector('simple', coalesce(text_content, '')))
```
directly over the raw `text_content` column. But
`src/repositories/whatsappMessageRepository.ts:134-160` (insert path)
and `:74-90` (`toRecord`) show `text_content` is written via
`getEncryptionService().encryptField(input.businessId, input.textContent)`
and read back via a `decryptTextContent()` helper that calls
`tryParse`/`decryptField` — i.e. **the column holds an encrypted
envelope (JSON: `{v, keyId, iv, authTag, ciphertext}`), not plaintext.**
A `GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text_content,
'')))`-shaped or index-only `to_tsvector(text_content)` expression run
by Postgres itself only ever sees that ciphertext-bearing JSON string —
it cannot decrypt it. **The GIN index at migration 007:54 is therefore
non-functional for real content search today**: it indexes tokens of an
encrypted blob, which can never usefully match a real search term. `grep
-rn "to_tsvector\|plainto_tsquery\|ts_rank" src/` confirms no code
anywhere actually queries this index (the only two real full-text
consumers in the codebase are `knowledge_base_documents` and this dead
`whatsapp_messages` index) — so this is a **latent, pre-existing,
currently-harmless-but-wasteful inefficiency** (Postgres still maintains
the index on every message write, for a capability nothing uses), not a
security bug and not something Phase B touches (touching
`whatsapp_messages` is out of scope per the "do not rewrite... existing
database architecture" rule). It's noted here only because it directly
answers Phase 2C's open question.

- **What this proves:** encrypting a column with `EncryptionService`
  and expecting Postgres's own generated/indexed `tsvector` to search it
  **does not work** — there is no precedent in this codebase for
  "encrypted column + working native full-text search over the same
  column," and the one place that looks like a precedent is actually
  proof of the opposite.
- **Options for `business_document_chunks.text`:**
  - **(A) Plaintext, unencrypted, tenant-scoped by `business_id`.**
    Exactly how `knowledge_base_documents.content` already works today
    (`src/db/migrations/055_knowledge_base_documents.sql:14`, plain
    `TEXT NOT NULL`, no encryption) — real, working, already
    security-audited (Phase 1/2A/2B/2C all reviewed this table and found
    no issue). Isolation boundary: the same `business_id`-scoped SQL
    query every other table in this system uses, not field encryption.
  - **(B) Field-encrypted, no native Postgres full-text search** —
    search would have to fetch-and-decrypt-then-scan in application
    code, which does not scale past a small number of documents per
    business and defeats the entire reason to use Postgres full-text
    search in the first place.
  - **(C) Field-encrypted, with a separately-populated (non-generated)
    `tsvector` column** — the application computes
    `to_tsvector('english', $plaintextParam)` as a bound parameter in the
    same `INSERT` that also computes the encrypted envelope from the same
    in-memory plaintext, storing both; the plaintext itself is never
    persisted as a column. This is technically workable but is a
    genuinely new pattern with zero precedent anywhere in this codebase,
    adds a real correctness burden (every future write path must
    remember to populate both derived columns from the same source, and
    keep them consistent on update), and only closes a threat this system
    doesn't actually have today: document *file bytes* are already
    encrypted at rest via `localEncryptedMediaStorage.ts` reusing
    `EncryptionService.encryptBuffer` (Phase 2C §3.4, unchanged) — the
    original document is protected. Chunk text is a *derived, extracted*
    artifact of that same file, at the same sensitivity level as CRM
    notes and knowledge-base content, both of which are already stored
    unencrypted in this system with a clean audit history.
- **Recommendation: (A).** Store `business_document_chunks.text` as
  plaintext, tenant-isolated by the same `business_id`-scoped SQL
  boundary as every other table in this system, matching
  `knowledge_base_documents`'s proven precedent exactly. Do not invent
  pattern (C) for Phase B. If a future compliance requirement demands
  field-level encryption of extracted document text specifically
  (distinct from the source file, which is already encrypted), that is
  a new, explicitly-scoped decision for a later phase, not a default to
  build now.
- **Blocks implementation?** No — resolved.

### 1.4 Embeddings

- Re-verified: `grep -rn "pgvector" src/db/migrations/` still only
  matches `055_knowledge_base_documents.sql`'s own comment stating it is
  absent from the `postgres:16-alpine` image this project runs.
- **Recommendation (unchanged from Phase 2C): do not build
  `business_document_embeddings` for real use in Phase B.** Extend the
  same `tsvector`/GIN/`ts_rank` approach `knowledge_base_documents`
  already runs successfully to `business_document_chunks.text`. Revisit
  only if lexical search demonstrably falls short in real usage, as its
  own separately-approved decision.
- **Blocks implementation?** No.

### 1.5 `knowledge_base_documents` vs. `business_documents` coexistence

- **Recommendation (unchanged from Phase 2C, now made concrete for the
  retrieval design in §6): keep both.** `knowledge_base_documents` stays
  the existing plain-text-paste "quick note" path (already entitled via
  `plan_entitlements.max_knowledge_base_documents`, already working, zero
  reason to migrate or deprecate it). `business_documents` is the new
  file-upload/versioned/chunked system. The AI retrieval layer
  (`search_company_knowledge`, §6) queries **both** sources, scoped
  identically by `business_id`, and merges bounded results — this is
  stated explicitly here because Phase 2C left it open and a retrieval
  design that silently queried only one would be a real functional
  regression for existing knowledge-base users.
- **Blocks implementation?** No.

### 1.6 Entitlements

- **Recommendation (unchanged): a `max_business_documents`-style
  `plan_entitlements` row, mirroring `max_knowledge_base_documents`
  exactly**, added in the same migration that creates
  `business_documents` (§8, Phase D1). Not designed further here —
  it's a single INSERT following an existing, proven pattern.
- **Blocks implementation?** No.

---

## 2. Current repository audit (fresh, direct, file:line-cited)

This section supersedes Phase 2C's own audit citations where they
overlap — every fact below was re-verified directly against the current
repository state during this phase, not carried forward from memory.

### 2.1 Existing knowledge base

`src/db/migrations/055_knowledge_base_documents.sql`: table
`knowledge_base_documents` — `id, business_id (NOT NULL FK →
businesses(id) ON DELETE CASCADE), created_by (NOT NULL FK → users(id)),
title, content (TEXT NOT NULL, plaintext), search_vector (TSVECTOR
GENERATED ALWAYS AS (setweight(to_tsvector('english', title),'A') ||
setweight(to_tsvector('english', content),'B')) STORED), created_at,
updated_at`. Indexes: `(business_id)`, GIN on `search_vector`. No
pgvector; migration's own comment states so explicitly. Plan
entitlements for `max_knowledge_base_documents`: starter=10, growth=50,
business=200, enterprise=NULL.

`src/repositories/knowledgeBaseRepository.ts` (`KnowledgeBaseRepository`,
line 42): every method (`create`, `findByIdForBusiness`,
`listForBusiness`, `countByBusiness`, `update`, `remove`, `search`) is
already business-scoped in SQL — **no unscoped `find(id)` variant exists
in this repository at all.** `search(businessId, queryText, limit)`
(line 113) builds an OR-combined `to_tsquery` rather than
`plainto_tsquery` specifically so a natural-language customer question
doesn't require every term to match (documented rationale, lines
98-111).

`src/services/knowledgeBaseSearchService.ts`:
`searchKnowledgeBase(businessId: string, queryText: string):
Promise<KnowledgeBaseSearchResult>` (line 30). Caps to `MAX_RESULTS = 3`
results, `SNIPPET_LENGTH = 400` chars per snippet. On a DB error, returns
`{available: false, results: [], reason}` — distinguishable from a real
empty result (`{available: true, results: []}`). `businessId` is a plain
function argument here, threaded from its one real caller,
`gatherAiHandoffContext` (`src/services/aiContextGathererService.ts:51`),
which itself receives it as a field of its own input object — i.e.
`businessId` flows in from whatever caller already resolved the
authenticated business, never re-derived or accepted from anywhere else
inside this path.

### 2.2 Encryption

`src/security/encryption/encryptionService.ts`, class
`EncryptionService` (line 17): AES-256-GCM (`ALGORITHM`, line 4),
12-byte IV, envelope `{v, keyId, iv, authTag, ciphertext}` (base64).
Public methods: `encryptField`/`decryptField` (string), `encryptBuffer`/
`decryptBuffer` (binary, "for media bytes"), `serialize`/`tryParse`
(`tryParse` returns `null`, not a throw, for legacy/non-envelope text —
this is what lets `decryptTextContent` in the message repository handle
pre-encryption rows).

DEK management: `EnvMasterKeyProvider`
(`src/security/encryption/kmsKeyProvider.ts:23`) derives a per-tenant
key via `HMAC-SHA256(masterKey, 'tenant-dek:' + tenantId)` from an env
var `MASTER_ENCRYPTION_KEY` — explicitly documented as not a real cloud
KMS, interface-shaped so one could be swapped in later.
`CachedKmsKeyProvider` (`src/security/encryption/keyCache.ts:13`) wraps
it with a Redis-backed 15-minute TTL cache, key prefix `kms:dek:`.
Singleton: `getEncryptionService()`
(`src/security/encryption/index.ts:8`).

**Reuse for Phase B:** document file bytes reuse `encryptBuffer`/
`decryptBuffer` exactly as media already does (§2.3); OAuth credential
references (§4.1) reuse `encryptField`/`decryptField` exactly as message
bodies already do. No new encryption primitive is proposed anywhere in
this document.

### 2.3 Media/document storage

`src/media/localEncryptedMediaStorage.ts`:
`buildStorageReference(businessId, sha256)` → `` `${businessId}/${sha256}` ``
(line 17-18). `resolveSafePath` (line 21, private) validates both path
segments against strict UUID/sha256 regexes before ever touching the
filesystem, throwing on anything else — this is the control that makes
path traversal via a forged storage reference structurally impossible,
not merely unlikely. `storeMedia(businessId, sha256, plaintext)` (line
39) dedupes identical bytes per tenant, encrypts via
`EncryptionService.encryptBuffer(businessId, plaintext)`, writes with
file mode `0o600`. `retrieveMedia(businessId, storageReference)` (line
51) resolves the safe path, parses the envelope, decrypts. Files are
tenant-isolated by directory (`MEDIA_STORAGE_DIR/<businessId>/...`) in
addition to encryption — two independent boundaries, not one.

**Reuse for Phase B:** document version file bytes reuse this module
directly (`storeMedia`/`retrieveMedia`/`buildStorageReference`), same as
Phase 2C already proposed. No new storage primitive.

### 2.4 MIME validation

`normalizeMimeType()` (`src/domain/whatsapp/mimeType.ts:14-16`): strips
`;param` suffixes, lowercases, comparison-only (raw value is still what's
stored). `mediaCompatibility.ts` defines allow-lists per media family
(`IMAGE_MIME_TYPES`, `VIDEO_MIME_TYPES`, `AUDIO_MIME_TYPES`, a 20-entry
`MIME_TO_EXTENSION` map including `application/pdf`, Office OOXML/legacy
types, `text/csv`, `text/plain`, `application/zip`) and a distinct
`INLINE_SAFE_MIME_TYPES` set (15 entries) that gates what's ever served
inline vs. as a forced attachment — explicitly to stop a WhatsApp
sender's self-declared MIME (e.g. `text/html`, `image/svg+xml`) from
running script in an authenticated agent's browser session. Notably,
`isSupportedMime()` (lines 77-83) is **not** an allow-list gate today —
it returns `Boolean(mimeType)`, true for any non-empty value; media
storage/download itself never refuses a file type, only *inline display*
is gated by `INLINE_SAFE_MIME_TYPES`. `heuristicShield.ts` runs a
**deny-list** (`EXECUTABLE_MIME_TYPES`, 9 entries; `EXECUTABLE_EXTENSIONS`
regex) against `normalizeMimeType()`'s output, blocking known-executable
uploads only.

**Implication for Phase B:** the existing media pipeline's
"store-anything, gate-inline-display" model is the wrong default for a
document-upload feature that will parse and extract text server-side —
§5 below specifies an explicit **allow-list**, fail-closed for document
ingestion (only MIME types with a real parser get past validation),
which is a deliberate, stated departure from the more permissive
existing media-download behavior, not an oversight.

### 2.5 Security audit logging

`src/db/migrations/028_create_security_audit_logs.sql`: table
`security_audit_logs` — `id, business_id (NOT NULL FK → businesses(id)),
whatsapp_account_id (nullable FK), event_type (NOT NULL, CHECK), severity
(CHECK IN info/warning/critical), reason, raw_metadata (JSONB NOT NULL
DEFAULT '{}'), created_at`. Index `(business_id, created_at DESC)`.

The `event_type` CHECK constraint has been widened **nine times** since
migration 028 via the established `ALTER TABLE security_audit_logs DROP
CONSTRAINT ...; ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` pattern
(migrations 041, 042, 044, 045, 047, 052, 053, 056, 058 — verified via
`grep -rn "ALTER TABLE security_audit_logs" src/db/migrations/`). This is
real, proven precedent for exactly the extension Phase 2C §13 proposes
(new `document_*` and, per this document, new `writing_twin_*` event
types) — Phase B's schema migrations follow this same drop/re-add
pattern rather than inventing a new mechanism.

`src/repositories/securityAuditLogRepository.ts`
(`SecurityAuditLogRepository`, line 90): `record()` (94) always writes
`business_id`; `listRecent(businessId, limit)` (113) and
`countRecentByBusinessAndTool(businessId, toolName, windowMinutes)` (127)
are both business-scoped in SQL. **Correction to an earlier-phase
assumption:** `record()` itself has no internal try/catch — a real DB
failure would propagate to the caller. Checked every call site across
the codebase (16 files); **none wrap `record()` in a local try/catch.**
This means "audit logging can never crash a caller" is **not** an
existing, verified property today — it was previously assumed, not
proven. This is a real, pre-existing gap, **out of scope for Phase B to
fix** (it predates this phase and isn't part of either new system), but
recorded here honestly rather than silently repeated as fact. Phase B's
own new audit-writing call sites (§9, §11) should follow whatever the
codebase's *dominant* existing convention turns out to be when those
phases are actually implemented — noted as a small, pre-existing,
independently-fixable item, not a Phase B blocker.

### 2.6 Authentication & session handling

`src/server/authMiddleware.ts:42-65` (`requireAuth`): reads only the
`wc_session` HttpOnly cookie (never body/query/params) →
`authService.validateSession(token)`
(`src/services/authService.ts:159-177`) → `sessionRepository.
findByTokenHash` → rejects on revoked/expired → `userRepository.findById`
must be `status='active'` → `membershipRepository.
findByUserAndBusiness` must be `status='active'` → builds `AuthContext =
{userId, businessId, role, sessionId, user}` on `res.locals.auth`.
Confirmed by direct grep: zero matches for any `req.body/query/params`
read of `businessId`/`userId` anywhere in `src/`.

**New finding, not previously documented:** `/api/workspace/*` routes do
**not** read `res.locals.auth.businessId` as their primary business
context. `requireWorkspaceContext`
(`src/server/index.ts:645-666`) instead reads
`whatsappConnectionService.getPersistedContext()` — the single live
Baileys socket's own connected business/account (this process holds
exactly one live WhatsApp connection at a time) — and cross-checks it
against `auth.businessId`, returning `403 BUSINESS_MISMATCH` on
disagreement. `res.locals.workspaceContext`, not `res.locals.auth`, is
what most workspace handlers actually destructure. This is
**EXISTING AND VERIFIED**, not a gap — the cross-check means a session
whose own `businessId` disagrees with the connected socket's business is
still refused — but it is an architectural fact Phase B's own new routes
must follow consistently: **any new document or Writing Twin route
should sit behind the same `requireAuth` + `requireWorkspaceContext`
pair** used everywhere else under `/api/workspace/*`, not a third,
new context-resolution mechanism.

### 2.7 AI context assembly

`gatherAiHandoffContext()` (`src/services/aiContextGathererService.ts:
42-70`) runs 5 lookups concurrently via `Promise.all`: CRM contact,
knowledge base search, conversation history (`messageRepository.
listByChat(chatId, limit)` — **not itself business-scoped in SQL**, only
`WHERE chat_id = $1`; tenancy is enforced upstream by however `chatId`
was already resolved), business record/timezone, inline media.

`buildSystemInstruction(agent, context)`
(`src/services/aiReplyService.ts:53-145`) is **already an ordered,
sectioned array of conditionally-pushed blocks** — role/time framing,
audio-capability framing (only if media present), agent persona, an
explicit **Context Trust Builder** boundary block (only if CRM notes or
KB results are present), CRM facts wrapped via `wrapUntrustedData
('crm_notes', ...)`, KB excerpts wrapped via `wrapUntrustedData
('knowledge_base', ...)`, category framing, hard scope-limit rules, final
"never invent facts/never claim to be human" rules. `wrapUntrustedData`
(lines 49-51) and `escapeUntrustedDataBoundary` (33-35, neutralizes a
forged `</untrusted_data>` sequence inside source text) are the existing
trust-boundary primitives.

**This is the exact, proven integration point for Phase B.** A future
`business_documents` retrieval block is a new labeled section wrapped
via `wrapUntrustedData('business_documents', ...)`, added into the same
`lines` array under the same convention as the existing
`knowledge_base` block. A future Writing Twin context block is a
**separate, new function** (§6.2) — not inserted into this same
persona-driven instruction, for a reason stated in §6.

### 2.8 WhatsApp message ownership / authorship model — the most consequential finding for the Writing Twin

`whatsapp_messages` (`src/db/migrations/007_create_whatsapp_messages.sql`):
authorship-relevant columns are `direction` (`inbound`/`outbound`),
`from_me` (boolean), `sender_jid`/`recipient_jid`, `sender_contact_id`/
`recipient_contact_id`. **No `user_id` or `agent_id` column exists on
this table.**

`whatsapp_outbound_messages` (`src/db/migrations/031_create_whatsapp_
outbound_messages.sql`): `requested_by` (TEXT, application-level
convention `'human'|'ai'`, **not** a DB CHECK-constrained enum) is the
only authorship signal. **No `user_id`/`agent_id` column exists here
either.** The one route that creates a human-sent WhatsApp message
(`POST /api/workspace/chats/:chatId/messages`, `src/server/index.ts:
777-812`) resolves `businessId` from `res.locals.workspaceContext`, not
`res.locals.auth`, and never passes `auth.userId` down to the send
service at all — every human-sent WhatsApp message is recorded as
`requested_by='human'` with **no linkage to which specific user (of
potentially several on the same business account) actually sent it.**
This is in sharp contrast to campaigns, funnels, email, and
knowledge-base writes, all of which already thread `auth.userId` through
to the row that gets written.

**FINDING W1 — genuinely blocks one specific claim, does not block Phase
B as a whole:** "the AI may learn communication patterns only from
content authored... by the authenticated user" (the Writing Twin's hard
security boundary) **cannot be honestly implemented for raw, passively-
observed WhatsApp human sends today**, because the data model cannot
answer "which user sent this" for that channel. Treating "any human send
on this business" as "this session's user's writing" would be a real
correctness/isolation risk the moment a business has more than one human
agent sharing an inbox — exactly the kind of "one employee's style
silently attributed to another" scenario the master directive's own
threat list names.

**Resolution, not a blocker:** Phase B does not build WhatsApp-message
passive learning in its first implementation phases at all (§8, Phase
W5 is explicitly deferred behind a small, additive prerequisite
migration: a nullable `sent_by_user_id` column on
`whatsapp_outbound_messages`, populated from `auth.userId` at the one
send route, once that route is updated to receive it). Until then, the
Writing Twin bootstraps from two channels where authorship is **already
real and reliable today**:
- **Correction learning** (any channel) — authorship is established by
  the live, authenticated request itself (the user editing/approving a
  draft *is* the authenticated session), never by a stored column, so
  this is unaffected by Finding W1.
- **Email**, which already has genuine per-user attribution:
  `email_messages.created_by`/`approved_by` (§2.10) are real `users.id`
  foreign keys, populated today.

### 2.9 Other channels

Direct repo-wide grep (`instagram`, `telegram`, `messenger`, `facebook`,
`tiktok`, `sms provider`, `twilio`, case-insensitive) returns **zero
application-code matches** — no stub, no disabled route, no type
definition. WhatsApp (Baileys) and email (Resend/SMTP) are the only two
channels that exist. Any "channel-specific style" design (§6.3) for a
channel other than these two is necessarily forward-looking schema
headroom, not something Phase B can wire end-to-end today.

### 2.10 CRM relationships

`crm_contacts` (`src/db/migrations/023_create_crm_contacts.sql` +
`048_contact_email.sql`): `business_id`, `whatsapp_contact_id` (nullable
FK — nullable specifically because the schema already anticipates
non-WhatsApp CRM origins, per its own migration comment), `owner_user_id`
(no FK yet — predates the auth system), `email`, plus CRM fields.
`leads` (`024_create_leads.sql`): `business_id`, `crm_contact_id` (NOT
NULL FK), `status` CHECK enum.

`LeadOwnershipResolver.resolve(businessId, chatId, entityId)`
(`src/services/entityOwnershipRegistry.ts:28-50`): `leadRepo.findById`
→ reject if `businessId` mismatch (`NOT_FOUND`) → resolve chat →
`crmContactRepo.findByWhatsAppContact` → final check `crmContact.id ===
lead.crmContactId`. **This is the exact pattern §7's document-send
gateway and §6's CRM-integration-prep reuse** for resolving "does this
chat/customer have a real relationship to this entity" without ever
trusting a client-supplied id directly.

### 2.11 Email infrastructure

`email_messages` (`src/db/migrations/045_email_messages.sql`, status
CHECK widened by `049_indeterminate_send_reconciliation.sql` to add
`'indeterminate'`): `business_id`, `created_by` (FK → users), `drafted_
by_agent_id` (FK → ai_agents), `chat_id` (FK → whatsapp_chats), `crm_
contact_id` (FK → crm_contacts), `kind`, `to_email`/`to_name`, `subject`,
`body_text`, `status` (draft/approved/sending/sent/failed/cancelled/
indeterminate), `approved_by`, `approved_at`, `sent_at`. DB-level CHECK:
any row in `('approved','sending','sent')` must have non-null
`approved_by`/`approved_at`. `approveAndSend()`
(`src/services/emailService.ts:177-205`) is documented as the only path
to sending, requiring a real, authenticated user id — never an agent,
never an automated caller (one narrow, explicitly-justified exception:
`sendFunnelEmail()`, which still attributes to a real `authorisedBy`
user id).

**This is the Writing Twin's cleanest bootstrap source**, per Finding
W1: `created_by`/`approved_by` are real, already-populated `users.id`
values, and every email draft that gets edited before approval is
already a live correction-learning candidate with zero new schema
required on the email side.

---

## 3. Threat model

Threats already fully closed by existing, tested infrastructure are
marked so explicitly — Phase B inherits them, doesn't re-solve them.

| Threat | Mitigation | Status |
|---|---|---|
| Cross-business document retrieval | Every document query scoped `WHERE business_id = executionContext.businessId` in the same SQL statement; cross-tenant id → `NOT_FOUND`, identical to nonexistent | PROPOSED (pattern EXISTING AND VERIFIED — Phase 1's 8 repositories, Phase 0.1's 3 fixes) |
| Cross-business document *chunk* retrieval | Same scoped-query rule applied at the chunk table, not just the document table (§4.3) | PROPOSED |
| Cross-user Writing Twin access | Every Writing Twin table carries **both** `business_id` and `user_id`; every repository method is `getForBusinessAndUser(id, businessId, userId)`-shaped | PROPOSED (pattern EXISTING AND VERIFIED for the business-only case — Phase 1) |
| Cross-business Writing Twin access | Same table/method, `business_id` is the first-checked column | PROPOSED |
| ID substitution (a real id from another tenant/user passed to a real endpoint) | Scoped query returns null; this exact class was the subject of Phase 0/0.1 (see `docs/PHASE_0_AUDIT.md`, `docs/PHASE_0.1` commit `2061228`) — same discipline applied to every new table here from day one, not retrofitted | PROPOSED, pattern EXISTING AND VERIFIED |
| `businessId` injection via an AI tool argument | No tool schema in this document ever declares a `businessId`/`userId` field — matches `update_lead`'s existing, verified shape (`aiToolPolicy.ts` has no such field, confirmed Phase 1 audit) | PROPOSED |
| Prompt injection inside a retrieved document | Every retrieved chunk wrapped in `wrapUntrustedData('business_documents', ...)` before reaching the model — same existing mechanism already protecting CRM notes/KB excerpts (`aiReplyService.ts:49-51,98-111`) | EXISTING AND VERIFIED (mechanism) / PROPOSED (applied to documents) |
| Hostile/malformed document parsing | Allow-list MIME gate before parsing (§5); parser isolated from the AI retrieval layer — a parser failure produces `status='failed'`, never a partially-poisoned chunk reaching the model | PROPOSED |
| Customer content silently becoming Writing Twin training data | Structural: a customer-authored message is never inserted into `user_writing_learning_events` under **any** disposition — the authorship gate runs *before* row creation, not as a post-hoc "rejected" label (§6.1) | PROPOSED |
| One employee's writing silently attributed to another's Writing Twin | Blocked by Finding W1's resolution — WhatsApp passive learning (the one channel without real per-user attribution) is deferred until `sent_by_user_id` exists; email/correction learning both have real per-request/per-column authorship today | PROPOSED |
| Stale or deleted Writing Twin data reused after deletion | Deletion is a real `DELETE`, not a soft-delete flag, cascaded via FK; every retrieval query additionally requires `learning_enabled = true` on the live profile row, so even a race between "deletion in flight" and "a retrieval reads the row a moment before" reads a row that, once gone, is gone — no orphaned child rows can outlive the parent (`ON DELETE CASCADE`) | PROPOSED |
| AI attempts to send a document it can read but isn't authorized to send | Read (`ai_retrievable`) and send (`ai_sendable`) are independent booleans with a DB CHECK that sendable implies retrievable but never the reverse; the send gateway (§7) is a wholly separate code path from retrieval, never reachable by "the AI already has the text" alone | PROPOSED (design carried from Phase 2C §7, unchanged) |
| Storage-provider (Drive/Dropbox) connection leakage across tenants | `business_storage_connections`/`business_storage_sources` both carry `business_id`; **out of scope for near-term implementation** — this document does not build the connector (§8 explicitly defers it) | DEFERRED |
| Background worker processes a mismatched business/document id pair | Every new worker in this system reads its own job's `businessId` and re-scopes its lookup with it — exactly the E1 fix from Phase 0.1 (`emailSendWorker.ts`, commit `2061228`), applied as a day-one rule here rather than a later patch | PROPOSED (pattern EXISTING AND VERIFIED — Phase 0.1) |
| Direct repository access bypassing a service-layer check | No unscoped `find(id)` method is proposed for any new table (§1.1-§1.6 policy) — there is nothing insecure to "bypass into," matching the Phase 2C repository-scoping policy | PROPOSED |
| AI context assembly mixes mismatched user/business data | The Writing Twin retrieval function (§6.2) takes the same authenticated `{businessId, userId}` pair as every other scoped call in this codebase, never a value read out of a document/message that could disagree with it | PROPOSED |

---

## 4. Hard invariants

Restated and extended from `docs/BUSINESS_EXECUTION_CONTEXT.md`'s
existing invariant (unchanged, still governs everything below):

> Every AI execution has exactly one authoritative business context.
> Every document operation, retrieval operation, storage operation, and
> outbound document action must execute inside that context. No
> model-visible argument can establish, replace, or broaden the context.

New invariants this phase adds:

1. **Dual scoping for personal data.** Every Writing Twin table carries
   both `business_id` and `user_id`. A query missing either check is a
   bug, not a stricter-than-needed check — both must hold, always,
   together.
2. **Customer content is never a Writing Twin candidate.** Not "marked
   rejected" — never inserted at all. The authorship gate is a
   precondition on row creation, not a disposition applied afterward.
3. **Read and send are different capabilities, never implied by each
   other except in the direction sendable → retrievable.** A tool that
   can retrieve a document's text can never, by that fact alone, send
   it.
4. **Deletion means deletion.** "Delete Writing Twin" is a real `DELETE`
   cascade, not a soft-delete flag re-filtered at read time. No shadow/
   history table retains the deleted content under a different name.
5. **No admin override by default.** A business admin/owner role does
   not automatically gain read access to another user's Writing Twin.
   That would require a new, explicitly-designed, separately-approved
   permission — not assumed here.
6. **Every repository method for a new table is scoped by construction.**
   No `find(id)`/`findByIdForBusiness`-without-`userId` variant is
   exposed for any Writing Twin table; no bare `find(id)` is exposed for
   any document table. This is the Phase 1/2C policy, applied from the
   first migration rather than retrofitted.
7. **Every new background worker re-derives its own scope from its own
   job payload**, never trusting that an earlier stage already checked
   it — the Phase 0.1 principle, restated as a standing rule for every
   job this phase's implementation eventually creates: *"an
   authorization check earlier in a call chain establishes permission,
   but where a downstream operation can cheaply re-enforce the same
   tenant boundary at the data-access layer, it should."*
8. **Fail closed on every classification default.** New documents:
   all four capability flags `false`. New Writing Twin profiles:
   `learning_enabled = false` until the user opts in.

---

## 5. Document ingestion — staged pipeline (design, Phase D2/D3)

Explicit allow-list, fail closed — a deliberate departure from the more
permissive existing media pipeline (§2.4), because this pipeline parses
and extracts text server-side, which the media pipeline never does.

| Stage | What happens | Failure behavior |
|---|---|---|
| 1. Upload | Multipart upload, `businessId`/`userId` from `requireAuth`+`requireWorkspaceContext` (§2.6), never from the request body | Oversized/malformed multipart rejected before any storage write |
| 2. Allow-list validation | Raw MIME normalized via `normalizeMimeType()` (reused, §2.4), checked against a new, explicit `DOCUMENT_ALLOWED_MIME_TYPES` allow-list (PDF, DOCX, plain text, CSV to start — not the media pipeline's broad "anything is supported" default) | Anything outside the allow-list: rejected before storage, `400`, never silently stored as "processing" |
| 3. Security screening | Existing `heuristicShield.ts` executable deny-list + extension check reused as-is (no new screening primitive) | Blocked payload never reaches storage |
| 4. MIME normalization | Store both raw (verbatim) and normalized `mime_family` — every later stage reads only `mime_family` | — |
| 5. Encrypted storage | Reuse `localEncryptedMediaStorage.ts` unchanged (§2.3) | Storage failure: document stays `status='uploaded'`, never advances |
| 6. Parser dispatch | By `mime_family`; unsupported family → `parser_status='unsupported'`, document reaches `status='failed'` honestly | No fabricated "parsed" state |
| 7. Text extraction | Parser-specific (§ Phase 2C §10, unchanged: PDF page-aware, DOCX heading-aware, plain text/CSV paragraph/row-based) | A parser crash is caught at the parser-dispatch boundary — never propagates into the retrieval layer |
| 8. Version creation | `business_document_versions` row, immutable once created | — |
| 9. Chunking | Per §Phase 2C §10 strategy, unchanged | — |
| 10. Search indexing | Plaintext `tsvector`/GIN over `business_document_chunks.text` (§1.3 resolution) | — |
| 11. AI retrieval | Only once `status='ready'` **and** `ai_retrievable=true` (human-set, defaults false) | A document stuck at any earlier stage is never visible to `search_company_knowledge` |

**Parser isolation from AI retrieval (explicit invariant):** a malformed
or hostile document can, at worst, fail parsing (`status='failed'`) — it
can never reach the retrieval layer in a partially-parsed or corrupted
state, because `ai_retrievable` is a human-set flag on the *document*,
never auto-flipped by the pipeline reaching `status='ready'`. This is a
deliberate two-gate design: the pipeline controls *whether content
exists to retrieve*; a human controls *whether the AI may retrieve it*.

---

## 6. Retrieval and AI context architecture

### 6.1 The layered context model

Restating the master directive's required separation, made concrete
against the real `buildSystemInstruction()` structure found in §2.7:

| Layer | Owner / trust boundary | Existing or new |
|---|---|---|
| Trusted execution context | Server-derived (`requireAuth`+`requireWorkspaceContext`, or the OpenClaw bearer-token/cell path) — never a prompt-visible value, only used to scope every layer below | EXISTING AND VERIFIED |
| Business knowledge | `knowledge_base_documents` + `business_documents` chunks, both scoped `business_id = context.businessId`, wrapped `wrapUntrustedData('business_documents', ...)` alongside the existing `wrapUntrustedData('knowledge_base', ...)` | Existing block extended, new block added |
| CRM/customer context | Existing `crmContact` gathering, unchanged | EXISTING AND VERIFIED |
| Current conversation | Existing `messageRepository.listByChat`, unchanged | EXISTING AND VERIFIED |
| User writing style | **New**, scoped `business_id = context.businessId AND user_id = context.actingUserId` — see §6.2 for why this is a separate function, not a `buildSystemInstruction()` addition | PROPOSED |
| Tool capabilities | Existing `aiToolPolicy.ts`/OpenClaw tool registry, unchanged | EXISTING AND VERIFIED |
| System instructions | Existing hard-rules block in `buildSystemInstruction()`, unchanged | EXISTING AND VERIFIED |

### 6.2 Why the Writing Twin is a separate context function, not a `buildSystemInstruction()` addition

`buildSystemInstruction()` builds the **business's AI agent persona**
(`agent.tone`/`agent.personality`/`agent.responseStyle`) for the
autonomous auto-reply pipeline — a business-level voice, not any one
employee's. The Writing Twin is the opposite: a specific, authenticated
human's own private style, relevant only when the system is drafting
*on behalf of that person* (a future "draft this email for me to
review" or CRM-aware compose feature), never for the autonomous
customer-facing auto-reply agent. Conflating the two would mean the
autonomous agent's replies could start leaking an individual employee's
personal writing quirks into a business-voiced conversation, and would
require threading a specific `userId` into a pipeline that today
correctly has none (the auto-reply pipeline acts as "the business," not
as any one person).

**Design:** a new function,
`buildWritingTwinContext(businessId: string, userId: string, channel:
string): Promise<WritingStyleContext | null>`, returns `null` whenever
`learning_enabled=false`, the profile doesn't exist, or confidence is
`'new'` with zero signal (nothing meaningful to contribute yet — never
fabricate a style). When non-null, it returns a **compact** structure:
the current `signal_summary` (§8, W1), a bounded number of
`approved_examples` (never a raw message dump), and any relevant
correction-derived preferences — never full historical correspondence.
This return value is consumed by a **future, separate** prompt-assembly
path for CRM-aware drafting (§6.4), not the existing auto-reply
`buildSystemInstruction()`, and is always scoped to exactly the
`{businessId, userId}` pair the authenticated request established —
never selected across users or businesses, matching Phase 2B's original
invariant applied to a new kind of data.

### 6.3 Channel-specific style

Per the master directive's explicit ask to recommend the simplest
architecture that supports future expansion: **one profile per
(business_id, user_id), with a `channel` column on the *signal* table**
(not the profile table) defaulting to a `'global'` sentinel row, plus
optional per-channel overlay rows (§8, `user_writing_style_signals`
unique on `(writing_profile_id, channel)`). V1 usage populates only the
`'global'` row; a `'whatsapp'`/`'email'` overlay row is additive schema
headroom, buildable later with zero migration to the profile table
itself. This is deliberately **not** "one unified profile with channel
metadata baked into a single JSONB blob" (harder to query/index a
specific channel's signals later) and **not** "N fully independent
profile tables per channel" (needless duplication of the on/off/
deletion/confidence machinery that's genuinely global to the person).

### 6.4 Integration prep for future CRM-aware generation

Per the master directive, this phase does not build CRM-aware email
generation — it only ensures the architecture doesn't collide with it
later. The future combined generation would call, independently:
Writing Twin context (§6.2), CRM/customer context (existing), business
knowledge (§6.1), current conversation (existing), then combine them
into **its own new prompt-assembly function** (not
`buildSystemInstruction()`, which stays the auto-reply agent's alone) —
each layer resolved by its own scoped call, never merged into one
uncontrolled string before each layer has independently enforced its own
boundary. This is a naming/separation commitment this document makes now
so that future work has an established seam to build into, not a design
this phase implements.

---

## 7. Controlled actions — the document-send security model

Unchanged from Phase 2C §12 in shape, reproduced here because the master
directive requires the send security model to be defined even though no
sending is implemented:

```
request_document_send(documentDescription, chatId)
 1. Authenticate business             (same as agentGuard.ts:121)
 2. Authenticate AI agent             (same as agentGuard.ts:126)
 3. Tool capability check             (same registered-tool-policy gate)
 4. Resolve chat → business/contact   (WhatsAppChatRepository.findByIdForBusiness, Phase 1 pattern)
 5. Resolve CRM contact from chat     (EntityOwnershipRegistry-style resolver, new "document" entityType)
 6. Resolve description → real document, scoped to business_id (NOT_FOUND, never ACCESS_DENIED)
 7. Confirm status='ready' AND ai_sendable=true
 8. Confirm business_document_access_policies.requires_approval_for_send
 9. If required: create pending_approval row, STOP, notify a human
10. Idempotency check (business_id, idempotency_key)
11. Dispatch via EXISTING whatsappOutboundMessageService.send() — no new send code path
12. Audit event written regardless of outcome (success, denial, every intermediate failure)
```

The model never supplies `document_id`, `business_id`, a phone number,
or a storage reference — only a description and the already-
authenticated `chatId`. No AI tool in this document's design ever
receives unrestricted send access to an arbitrary resource; sending a
document it can read still requires `ai_sendable=true` independently of
`ai_retrievable`, and still passes through this entire gateway, not a
shortcut from the retrieval path.

---

## 8. Final schema proposal

### 8.1 Document system (carried forward from Phase 2C §3, with §1's resolutions applied)

Full column-level rationale lives in Phase 2C §3 and is not repeated
here in full; this table states the finalized shape after this phase's
review.

| Table | Ownership | Key FKs | Unique | Deletion | Tenant isolation | Retention | Encryption |
|---|---|---|---|---|---|---|---|
| `business_storage_connections` | business | `business_id`→businesses | `(business_id, provider)` where `revoked_at IS NULL` | Soft (`revoked_at`), never hard-deleted while sources reference it | `business_id` denormalized (§1.2: app-layer trust, no trigger yet) | Indefinite (audit value) | `credential_reference` via `EncryptionService.encryptField` — raw token never stored |
| `business_storage_sources` | business | →storage_connections | `(storage_connection_id, external_id)` | Marked `is_deleted_upstream`, not hard-deleted | `business_id` denormalized | Indefinite | none (metadata only) |
| `business_documents` | business | →storage_sources (nullable) | — | Soft (`deleted_at`) | `business_id` NOT NULL FK | Indefinite until explicit deletion | none (file bytes encrypted at version level) |
| `business_document_versions` | business | →business_documents | `(document_id, version_number)` | Never deleted on new-version creation; explicit purge only | `business_id` denormalized | Indefinite (old versions retained) | File bytes: `EncryptionService.encryptBuffer` via `localEncryptedMediaStorage.ts` (reused, unchanged) |
| `business_document_chunks` | business | →versions | `(version_id, sequence)` | Cascades with version deletion | `business_id` denormalized | Indefinite | **Plaintext (§1.3 resolution)** — isolation via scoped SQL, not field encryption |
| `business_document_embeddings` | business | →chunks | `(chunk_id, embedding_model, model_version)` | N/A | N/A | N/A | **Not built in Phase B (§1.4)** |
| `business_document_access_policies` | business | — | `business_id` UNIQUE | Deleted with business | `business_id` UNIQUE PK-equivalent | Indefinite | none |
| `business_document_send_requests` | business | →documents, →versions, →chats | `(business_id, idempotency_key)` | Never deleted (audit value) | `business_id` denormalized | Indefinite | none (metadata only, never document content) |

### 8.2 Writing Twin system — new design (this phase)

Four tables, each with a distinct, non-overlapping purpose — no table
created without a clear reason, per the master directive's constraint.

#### `user_writing_profiles`

One row per `(business_id, user_id)` — the settings/state surface.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL FK → businesses(id) | tenant boundary |
| `user_id` | UUID NOT NULL FK → users(id) ON DELETE CASCADE | the second, equally mandatory boundary |
| `learning_enabled` | BOOLEAN NOT NULL DEFAULT false | **opt-in, fails closed** |
| `learning_paused_at` | TIMESTAMPTZ NULL | distinct from disabling — a pause is a temporary hold, not a policy change |
| `confidence_level` | TEXT CHECK IN ('new','developing','confident','highly_personalized') NOT NULL DEFAULT 'new' | see §9 for how this is computed |
| `approved_signal_count` | INTEGER NOT NULL DEFAULT 0 | denormalized counter for a cheap status read, recomputed alongside confidence |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Unique: `(business_id, user_id)`. **No `deleted_at`** — deletion (§4
invariant 4) removes the row for real; recreating a profile after
deletion is simply a new row with fresh defaults.

#### `user_writing_style_signals`

The current, recomputed **aggregate** — not a growing log. One row per
`(profile, channel)`, `channel='global'` by default (§6.3).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id`, `user_id` | UUID NOT NULL | denormalized, both required |
| `writing_profile_id` | UUID NOT NULL FK → user_writing_profiles(id) ON DELETE CASCADE | |
| `channel` | TEXT NOT NULL DEFAULT 'global' | `'global'` sentinel, or `'whatsapp'`/`'email'` overlay |
| `signal_summary` | JSONB NOT NULL DEFAULT '{}' | deterministic metrics only (§9.1) — greeting/closing patterns, avg sentence length, punctuation habits, formality score, emoji frequency, common phrases |
| `sample_count` | INTEGER NOT NULL DEFAULT 0 | how many accepted learning events contributed to the current summary |
| `last_recomputed_at` | TIMESTAMPTZ NULL | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Unique: `(writing_profile_id, channel)`. Recomputed from
`user_writing_learning_events`, not itself a source of truth for raw
content — it's a derived artifact, which is what makes the retention
policy on the raw table (below) safe: pruning old raw events doesn't
lose the aggregate they already contributed to.

#### `user_writing_approved_examples`

A **bounded** cache of short snippets, for the rare case the retrieval
layer (§6.2) wants a concrete example rather than only a metric summary.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id`, `user_id` | UUID NOT NULL | |
| `writing_profile_id` | UUID NOT NULL FK, ON DELETE CASCADE | |
| `channel` | TEXT NOT NULL DEFAULT 'global' | |
| `example_text` | TEXT NOT NULL, bounded length (e.g. 500 chars) | never a full conversation |
| `source_type` | TEXT CHECK IN ('correction','direct_approval') | |
| `created_at` | TIMESTAMPTZ | |

**Retention:** capped count per `(profile, channel)` — application-
enforced (keep most-recent-N, prune the rest), not unbounded growth.

#### `user_writing_learning_events`

The raw pipeline's audit trail — the table that actually distinguishes
every state the master directive requires.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id`, `user_id` | UUID NOT NULL | |
| `writing_profile_id` | UUID NOT NULL FK, ON DELETE CASCADE | |
| `channel` | TEXT NOT NULL | |
| `event_type` | TEXT CHECK IN ('correction','direct_message') NOT NULL | |
| `authorship_basis` | TEXT CHECK IN ('correction_diff','email_approval','explicit_user_submission') NOT NULL | **how** authorship was established for this specific row — auditable per-event, directly answering the master directive's "define exactly how the system determines authorship" |
| `source_message_id` | UUID NULL | whichever table it came from, when applicable |
| `ai_draft_text` | TEXT NULL | only for `event_type='correction'` — the AI's original draft |
| `final_text` | TEXT NOT NULL | the user's approved/sent version — the actual learning input |
| `was_edited` | BOOLEAN NOT NULL | `final_text != ai_draft_text` |
| `was_sent` | BOOLEAN NOT NULL DEFAULT false | distinguishes "approved but never sent" from "actually sent" |
| `disposition` | TEXT CHECK IN ('pending','accepted','rejected') NOT NULL DEFAULT 'pending' | the learning-candidate → accepted/rejected signal state |
| `rejection_reason` | TEXT NULL | e.g. `learning_disabled_at_time_of_event`, `retention_expired` |
| `created_at`, `processed_at` | TIMESTAMPTZ | |

**Retention (explicit, required by the master directive):** a
configurable window (proposed default 90 days) after which
`ai_draft_text`/`final_text` are purged by a real `DELETE`, not merely
hidden — the row's contribution already lives on in the recomputed
`signal_summary`, so pruning raw content here loses no aggregate value.
No indefinite raw-draft retention.

**Customer content, restated as a schema-level fact:** there is no
column on this table, and no code path proposed anywhere in this design,
that inserts a row here from customer-authored text. `event_type` has
exactly two values, both about the *user's own* writing. This is
structural, not a filter applied after the fact.

---

## 9. Confidence model, learning controls, and correction pipeline

### 9.1 Style signal extraction — Option A vs. B, decided

- **Option A (rule-based, deterministic):** greeting/closing patterns,
  sentence/paragraph length, punctuation, emoji frequency, common
  phrases, formality indicators — computed in plain TypeScript, no
  additional model call.
- **Option B (LLM-assisted summarization):** send a controlled set of
  the user's own approved messages to an LLM, get back a structured
  style profile.
- **Recommendation: Option A only, for all of Phase B.** Reasons,
  concretely: (1) deterministic and cheap — no additional Gemini call
  per learning event, no new cost surface; (2) auditable — a signal
  summary computed by explicit rules can be inspected and explained,
  exactly matching this codebase's existing "no security property
  without an exact mechanism" standard; (3) it avoids a real, new
  prompt-injection surface (a user's own message content is, by
  definition, less adversarial than a customer's, but "less
  adversarial" is not "safe to skip a design review for" — an
  LLM-summarization step over user content is new attack surface this
  document should not open casually); (4) it avoids a real, new privacy
  question (sending a user's private writing to an LLM provider for
  analysis, distinct from sending it for a specific reply-generation
  purpose the user already expects). **Option B is explicitly deferred**
  to a future, separately-approved phase, only if Option A's signal
  quality proves insufficient in real usage — not built speculatively
  now.

### 9.2 Confidence levels

Computed from real evidence, not a meaningless counter:

| Level | Basis |
|---|---|
| `new` | `sample_count = 0` |
| `developing` | `sample_count` below a threshold (e.g. 10), or signals inconsistent across recent events |
| `confident` | `sample_count` above threshold, consistent signals across a recent window |
| `highly_personalized` | Sustained consistency over an extended window, including recent correction-derived evidence, across more than one channel where applicable |

The model never claims perfect understanding — `buildWritingTwinContext`
(§6.2) surfaces the confidence level alongside the style context so any
future consuming prompt can hedge appropriately ("write in a style that
leans toward what I've learned so far" vs. "write exactly in this
established voice"), rather than a Phase B implementation detail
inventing that language now.

### 9.3 Correction pipeline (design)

1. AI generates a draft (existing capability, unchanged).
2. User edits or rewrites it (existing UI interaction).
3. User sends it, **or** explicitly approves it without sending (both
   are valid triggers per the master directive's own wording).
4. System compares `ai_draft_text` vs. `final_text` — `was_edited`
   computed directly from this diff.
5. A `user_writing_learning_events` row is created with
   `disposition='pending'`, `authorship_basis='correction_diff'`
   (authorship is trivial here — it's the live authenticated request).
6. A deterministic extraction pass (§9.1) updates the pending row toward
   `disposition='accepted'` **only if** `learning_enabled=true` on the
   profile at the moment of processing — checked fresh, not cached from
   step 1, so a user who disables learning between drafting and sending
   is still respected. Otherwise `disposition='rejected'`,
   `rejection_reason='learning_disabled_at_time_of_event'`.
7. Only `accepted` events feed `user_writing_style_signals`'s
   recomputation.

### 9.4 Learning controls

| Control | Effect |
|---|---|
| Learning ON/OFF | Toggles `learning_enabled`. Turning OFF immediately stops new signals — checked fresh at processing time (§9.3 step 6), not just at candidate-creation time. |
| Pause learning | Sets `learning_paused_at`; distinct from OFF — existing signal summary stays available for retrieval, but no new events are accepted while paused. |
| Delete Writing Twin | Real `DELETE` of the profile row, cascading to every child table via `ON DELETE CASCADE`. A `security_audit_logs` entry (`writing_twin_deleted`) records only `{business_id, user_id, deleted_row_counts}` — never any of the deleted content. **Caveat, stated honestly per the "do not claim a security property without proof" rule:** database-level backups/replication snapshots are outside this document's control and may retain deleted data until their own retention window expires — this is an existing, unchanged operational fact about the whole database, not something this feature can uniquely guarantee against. Flagged `UNKNOWN / REQUIRES VERIFICATION` against whatever backup policy the deployment actually runs. |
| Reset Writing Twin | Deletes all rows in the three child tables, resets `confidence_level='new'`/`approved_signal_count=0` on the profile, but keeps the profile row and its settings (`learning_enabled`, channel controls) — "start over" without re-doing the opt-in. |
| View learning status | Read of `user_writing_profiles` + `user_writing_style_signals`, scoped to the caller's own `{businessId, userId}` — never another user's. |
| Approved signal count | `approved_signal_count`, kept in sync whenever `disposition` moves to `'accepted'`. |
| Confidence indicator | `confidence_level`, §9.2. |
| Channel-specific controls (optional) | `learning_enabled` could later gain a per-channel override table; not built in Phase B — the `channel` column on the signal/example/event tables is the schema headroom this would need, already present. |

---

## 10. Implementation phases

Each phase is independently testable, has its own migration(s) matching
this codebase's one-concern-per-migration convention, and its own
completion gate. No phase bundles document work and Writing Twin work
together.

### Document track

| Phase | Purpose | Files | Schema | Security properties | Tests required | Rollback | Completion gate |
|---|---|---|---|---|---|---|---|
| **D1** | Manual-upload document foundation, no chunking/search/send yet | New: `businessDocumentRepository.ts`, `documentService.ts`, upload API route | `business_documents`, `business_document_versions`, `plan_entitlements` addition | Scoped-only repository methods (§4 invariant 6); MIME allow-list (§5 stages 1-5); reuse existing encryption/storage | Cross-tenant `getForBusiness` denial; MIME allow-list rejection; entitlement-limit enforcement | `DROP TABLE`, additive-only migration | Full suite green; new adversarial tests green; typecheck/build clean |
| **D2** | Parsing/chunking pipeline | New: parser dispatch module, chunker | `business_document_chunks` | Parser isolation from retrieval (§5); fail-closed `parser_status` | Malformed-file parsing never crashes the pipeline; unsupported MIME → `status='failed'` honestly, never fabricated `'ready'` | `DROP TABLE` | Same as D1 |
| **D3** | Search + AI retrieval | `knowledgeBaseSearchService.ts`-equivalent for documents, `search_company_knowledge` tool, `buildSystemInstruction()` extension (§6.1) | `business_document_access_policies` | Plaintext chunk search (§1.3); `wrapUntrustedData` boundary on every retrieved chunk; `ai_retrievable` gate | Cross-tenant chunk search denial (matrix #3); prompt-injection-in-document-content non-effect (matrix #15) | `DROP TABLE` | Same, plus a live Gemini-facing round-trip test matching `openclawToolGateway.test.ts`'s style |
| **D4** | Document send gateway | New tool + gateway class mirroring `openclawToolGateway.ts` | `business_document_send_requests`; `ALTER TABLE security_audit_logs` (established widen pattern, §2.5) | Full 12-step gateway (§7); `ai_sendable` independent of `ai_retrievable`; default `requires_approval_for_send=true` | Full adversarial matrix items #17-20 | `DROP TABLE` / constraint revert | Same, plus a real end-to-end "pending approval, never auto-sent" test |
| **D5 — explicitly future, not part of this implementation round** | Google Drive/Dropbox OAuth connector | — | `business_storage_connections`, `business_storage_sources` | `drive.file`-scope-equivalent narrowest OAuth | — | — | Named here only so the sequence is visible; **not started, not approved for this round** |

### Writing Twin track

| Phase | Purpose | Files | Schema | Security properties | Tests required | Rollback | Completion gate |
|---|---|---|---|---|---|---|---|
| **W1** | Settings/control surface only, no learning pipeline | `userWritingProfileRepository.ts`, minimal settings API | `user_writing_profiles` | Dual `{business_id, user_id}` scoping (§4 invariant 1); opt-in default false | Cross-user profile denial; cross-business denial | `DROP TABLE` | Full suite green; typecheck/build clean |
| **W2** | Correction-learning pipeline, email-bootstrap only | Wired into the existing email draft→approve flow (§2.11) | `user_writing_learning_events` | Authorship gate is structural (§4 invariant 2); `learning_enabled` checked fresh at processing (§9.3) | Forged/customer-authored content never persisted (matrix #6); learning-disabled-mid-flight event correctly rejected (matrix #9) | `DROP TABLE` | Same |
| **W3** | Aggregate computation + bounded examples + retention | Recompute job, prune job | `user_writing_style_signals`, `user_writing_approved_examples` | Retention window enforced (§8.2); deterministic-only extraction (§9.1) | Retention prune removes raw content while aggregate survives; example cache stays bounded | `DROP TABLE` | Same |
| **W4** | Scoped retrieval layer, stubbed integration point only | `buildWritingTwinContext()` (§6.2) | — | Never selected across users/businesses; returns `null` on low confidence rather than fabricating style | Cross-tenant/cross-user retrieval denial (matrix #4/#5); stale-after-deletion retrieval denial (matrix #8) | — | Same |
| **W5 — explicitly gated, not started this round** | WhatsApp passive-learning bootstrap | Requires: `sent_by_user_id` migration on `whatsapp_outbound_messages` + send-route wiring (Finding W1) | `ALTER TABLE whatsapp_outbound_messages ADD COLUMN sent_by_user_id` | Closes Finding W1 first | — | — | **Blocked until the prerequisite column + route change is itself reviewed** — not silently bundled into W1-W4 |

---

## 11. Adversarial test matrix

Consolidated from Phase 2C's 20 document-focused cases and the master
directive's 13 additional cases, deduplicated, each mapped to the real
existing test pattern it should follow (Phase 0/0.1 established these
patterns concretely — cited directly rather than invented fresh).

| # | Case | Mechanism / pattern to follow |
|---|---|---|
| 1 | Business A requests Business B's document by id | `getForBusiness(docId, businessB)` → null; same shape as `test/whatsappOutboundMessageRepository.test.ts`'s `findByIdForBusiness` cross-tenant test (Phase 0.1) |
| 2 | Business A requests Business B's document version | Same pattern, version table |
| 3 | Business A searches Business B's chunks | Seed real, highly-relevant Business B content; assert it never appears in Business A's search results — same style as the Phase 1 funnel/media cross-tenant tests |
| 4 | Business A retrieves Business B's document chunk directly (not via search) | Scoped `getForBusiness` denial |
| 5 | User A's Writing Twin requested by User B (same business) | `getForBusinessAndUser` → null when `user_id` mismatches, even with matching `business_id` |
| 6 | Business A's Writing Twin data requested by Business B | Same method, `business_id` mismatch |
| 7 | AI agent attempts cross-business document access via a tool | `search_company_knowledge`/`get_customer_safe_document` — assert `executionContext.businessId` is the only value ever used regardless of query text content |
| 8 | AI agent supplies a forged `businessId`/`documentId`/`cellId` | Structural — no tool schema accepts these fields at all; same assertion style as `test/agentGuard.test.ts`'s forged-businessId case |
| 9 | Stale `cellGeneration` reused against a document tool | Same fencing test as `test/openclawToolGateway.test.ts:190`, re-run against any document tool built on the same gateway |
| 10 | Wrong-tenant `chat_id` supplied to the document-send gateway | Same pattern as `test/openclawToolGateway.test.ts:116` |
| 11 | Customer message incorrectly submitted as Writing Twin learning data | Assert no row is ever created in `user_writing_learning_events` for a message whose `authorship_basis` cannot be established as the authenticated user's own — the gate must run *before* insertion, so this test asserts row-count stays zero, not that a row exists with `disposition='rejected'` |
| 12 | Forged learning event (a request claims `authorship_basis='correction_diff'` without a real corresponding draft/edit) | Service-layer validation rejects before repository insert; matches the "fail closed, no fallback lookup" principle from `BUSINESS_EXECUTION_CONTEXT.md` |
| 13 | Stale style profile retrieved after deletion | Delete profile, immediately call `buildWritingTwinContext` for the same `{businessId, userId}` → `null`, not a cached/stale summary |
| 14 | Learning disabled mid-flight, a new signal attempts to persist | §9.3 step 6 — event created while enabled, `learning_enabled` flips to false before processing, event resolves `disposition='rejected'`, `rejection_reason='learning_disabled_at_time_of_event'` |
| 15 | AI attempts to send a document it can read but isn't `ai_sendable` | Seed `ai_retrievable=true, ai_sendable=false`; assert `request_document_send` never dispatches — same style as Phase 2C's own matrix #17 |
| 16 | Background worker (document parse/chunk job, Writing Twin recompute job) processes a mismatched business/document or business/user id pair from its own job payload | Direct analog of Phase 0.1's E1 test (`test/emailSendWorker.test.ts`) — a forged job payload with a real id from one tenant and a `businessId` from another; assert no read/mutation/exposure occurs |
| 17 | Direct repository access attempt bypassing the service layer | N/A by construction — no unscoped `find(id)` exists to bypass into (§4 invariant 6); test asserts the method itself doesn't exist / always requires both scope arguments |
| 18 | AI context assembly with mismatched user/business data | `buildWritingTwinContext(businessA, userFromBusinessB, ...)` → asserts either an error or `null`, never a cross-context blend |
| 19 | Concurrent document deletion/send race | Optimistic-concurrency re-check at send time (§7 step 7), same shape as `outboundDispatchWorker.ts`'s existing indeterminate-state handling |
| 20 | Revoked storage connection still attempts a sync (deferred system, D5) | Named for completeness; not testable until D5 exists |

Every case becomes a real, Postgres-backed test once its schema exists —
no mocking the tenant boundary itself, matching how every existing
cross-tenant test in this codebase already works.

---

## 12. Verification

No code was changed in this phase — this document is the only new
artifact. Re-running the existing baseline confirms nothing regressed
while producing it:

- **Targeted re-run** (the three files touched by Phase 0.1, to confirm
  the checkpoint this phase builds on is still exactly as reported):
  `test/emailSendWorker.test.ts`, `test/whatsappOutboundMessageRepository.test.ts`,
  `test/openclawToolGateway.test.ts` — see below.
- **Full suite, typecheck, production build** — see below.

---

## 13. Implementation gate

Per the master directive: **STOP here.** No migration, no document
table, no Writing Twin table, no Google Drive/Dropbox connection, no
upload implementation, no parsing implementation, no style-learning
implementation, no production AI prompt change, and no unrelated
refactor has been made in this phase. This document is submitted for
review. Phase B's actual implementation (starting from Phase D1/W1 in
§10) does not begin until this architecture is explicitly approved.
