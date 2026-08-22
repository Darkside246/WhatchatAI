# Phase 2C — Document Security & Knowledge Architecture Proposal

**Status: PROPOSAL ONLY. No migration exists. No application code has been
written or modified. No Google Drive/Dropbox integration exists.**

This document is a design for review. Every claim below is labeled
`EXISTING AND VERIFIED`, `PROPOSED`, `DEFERRED`, or `UNKNOWN / REQUIRES
VERIFICATION`. Nothing here should be read as already implemented unless
labeled `EXISTING AND VERIFIED`. Per instruction, this phase does not
touch `docs/BUSINESS_EXECUTION_CONTEXT.md`'s invariants, the OpenClaw
gateway, or any existing tenant-isolation control — it builds strictly
on top of them.

---

## 1. Architecture overview

```
                          BUSINESS
                              │
                    Business Execution Context
              (businessId - EXISTING AND VERIFIED,
               server-derived only, see 2B)
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                      │
        ▼                     ▼                      ▼
  STORAGE LAYER        KNOWLEDGE LAYER          AI CAPABILITY LAYER
  ┌─────────────┐     ┌──────────────┐         ┌──────────────────┐
  │ storage_    │     │ documents    │         │ search_company_   │
  │ connections │────▶│  └versions   │◀───────▶│  knowledge()      │
  │ storage_    │     │    └chunks   │         │ get_customer_safe_│
  │ sources     │     │      └embed- │         │  document()       │
  │ (2G, later) │     │       dings  │         │ request_document_ │
  └─────────────┘     │ access_      │         │  send()           │
                       │  policies    │         │ (2H, later)       │
                       │ send_        │         └──────────────────┘
                       │  requests    │
                       └──────────────┘
                              │
                              ▼
                  security_audit_logs (EXISTING,
                  extended - see section 13)
```

Every box in the Knowledge/Storage layers carries `business_id` as a
first-class column, and every access path (human, AI, worker, sync job)
resolves it from the authenticated context established in 2B — never
from an object id alone.

## 2. Data-flow diagram (the two flows that matter most)

**Ingestion (2D/2E/2G, none built yet):**
```
Upload OR Storage-Source sync job
        │  (businessId from session / from storage_sources.business_id,
        │   never from the uploaded file's own metadata)
        ▼
business_documents (new logical doc, or new version of existing doc)
        ▼
business_document_versions (status=uploaded)
        ▼
Parser (PDF/DOCX/... - 2D)              → parser_status
        ▼
Chunker (semantic, page-aware - 2D)     → business_document_chunks
        ▼
Embedder (OPTIONAL, deferred - see §11) → business_document_embeddings
        ▼
status=ready
```

**Retrieval + send (2F/2H, none built yet):**
```
AI: "find the return policy" / "send the catalogue to this customer"
        ▼
search_company_knowledge(executionContext, query)   [2F]
   or
request_document_send(executionContext, intent)     [2H]
        │
        │  executionContext.businessId is server-derived (2B) -
        │  the model supplies intent/query text only, never an id
        ▼
Scoped Knowledge Service / Document Action Gate
   - resolves candidate documents WHERE business_id = executionContext.businessId
   - (send path) re-verifies: document ownership, classification,
     ai_sendable, recipient/CRM relationship, approval policy
        ▼
Result: retrieved chunks (bounded, business-scoped)
   or: sent / pending_approval / denied  + security_audit_logs row
```

## 3-4. Proposed tables and relationships

All tables below are **PROPOSED** - none exist. Every table carries
`business_id`; every foreign key that points to another table in this
group is `(target_id, business_id)` compound-checkable, and every
repository method that will front these tables follows the Phase 1
pattern (`getForBusiness`/`listForBusiness`/etc., never bare `findById`).

### 3.1 `business_storage_connections` — PROPOSED

Purpose: one OAuth connection per business per external provider.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL FK → businesses(id) | **tenant boundary** |
| `provider` | TEXT CHECK IN ('google_drive','dropbox') | no 'local' - uploads never need a connection row |
| `connected_by_user_id` | UUID FK → users(id) | who authorized it (audit trail, not an access boundary) |
| `credential_reference` | TEXT NOT NULL | **not the token itself** - an opaque reference into the existing `EncryptionService.encryptField`/`decryptField` envelope (same primitive already used for message bodies), keyed per-business. The raw OAuth token/refresh token is never stored in plaintext, and never returned by any repository method used by AI-facing code. |
| `oauth_status` | TEXT CHECK IN ('connected','expired','revoked','error') | |
| `scopes_granted` | JSONB NOT NULL DEFAULT '[]' | e.g. `["drive.readonly"]` - narrowest scope the provider allows, never broad/unrestricted |
| `last_successful_sync_at` | TIMESTAMPTZ NULL | |
| `last_failed_sync_at` | TIMESTAMPTZ NULL | |
| `last_error` | TEXT NULL | never a raw provider error containing a token |
| `revoked_at` | TIMESTAMPTZ NULL | set on disconnect (§6) |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Unique: `(business_id, provider)` where `revoked_at IS NULL` - one live
connection per provider per business (partial unique index, same pattern
already used for `subscriptions`' one-live-subscription constraint).

Deletion behavior: never hard-deleted while any `business_storage_sources`
row references it (see §6). Disconnect sets `revoked_at`, does not
delete the row (audit value).

### 3.2 `business_storage_sources` — PROPOSED

Purpose: the explicit, company-chosen allow-list of folders/files - a
connection alone grants nothing.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL FK → businesses(id) | **tenant boundary**, denormalized from the connection for a single-table WHERE clause even though it's also derivable via the FK - see §"why denormalize" below |
| `storage_connection_id` | UUID NOT NULL FK → business_storage_connections(id) | |
| `external_id` | TEXT NOT NULL | provider's folder/file id |
| `source_type` | TEXT CHECK IN ('folder','file') | |
| `display_name` | TEXT NOT NULL | for the UI, never trusted for authorization |
| `sync_status` | TEXT CHECK IN ('pending','syncing','synced','error','removed') | |
| `last_synced_at` | TIMESTAMPTZ NULL | |
| `last_error` | TEXT NULL | |
| `external_revision_id` | TEXT NULL | last known top-level revision seen (folders: a sync cursor; files: the file's own revision) |
| `is_deleted_upstream` | BOOLEAN NOT NULL DEFAULT false | provider reports the file/folder gone |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Unique: `(storage_connection_id, external_id)`.

**Why denormalize `business_id` onto every table instead of relying on a
join through `storage_connection_id`:** this is the single most
important structural decision in this proposal, so it's stated once
here and then assumed for every table below. A join-based check (`...
JOIN business_storage_connections ON ... WHERE business_storage_connections.business_id
= $1`) is still a real SQL-level boundary, but it requires every future
query author to remember to write the join correctly. A denormalized
`business_id` column lets every repository method express the boundary
as a single `WHERE id = $1 AND business_id = $2` - the same shape Phase
1 already established, and the shape that's hardest to get wrong under
time pressure. The trade-off (a duplicated column that must be kept
consistent with the parent) is handled the same way `whatsapp_media`
already handles it for messages/statuses: set once at insert time from
the same authenticated context that creates the parent row, never
updated independently, and enforced by a `CHECK`/trigger only if the
Phase 2C review decides the duplication risk is worth that extra
mechanism (flagged as an open decision in §20, not resolved here).

### 3.3 `business_documents` — PROPOSED

Purpose: the stable logical identity of a document across its versions.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL FK → businesses(id) | **tenant boundary** |
| `source_type` | TEXT CHECK IN ('upload','google_drive','dropbox') | |
| `storage_source_id` | UUID NULL FK → business_storage_sources(id) | NULL for manual uploads |
| `external_file_id` | TEXT NULL | provider's stable file id, for connector-sourced docs only |
| `filename` | TEXT NOT NULL | |
| `current_version_id` | UUID NULL FK → business_document_versions(id) | the "current" pointer; NULL until the first version is fully processed |
| `status` | TEXT CHECK IN ('uploaded','processing','ready','failed','stale','quarantined','deleted') | see §12 for the full lifecycle/capability table |
| `ai_retrievable` | BOOLEAN NOT NULL DEFAULT false | independent capability flag - see §7 |
| `ai_sendable` | BOOLEAN NOT NULL DEFAULT false | independent capability flag |
| `customer_visible` | BOOLEAN NOT NULL DEFAULT false | independent capability flag |
| `human_only` | BOOLEAN NOT NULL DEFAULT false | when true, `ai_retrievable`/`ai_sendable` MUST be false - enforced by CHECK |
| `created_by_user_id` | UUID NOT NULL FK → users(id) | |
| `created_at`, `updated_at`, `deleted_at` | TIMESTAMPTZ | soft delete, see §6 |

CHECK: `NOT (human_only AND (ai_retrievable OR ai_sendable))` - a
document cannot simultaneously be human-only and AI-accessible; this is
enforced by the database, not just application logic. A second CHECK:
`NOT (ai_sendable AND NOT ai_retrievable)` - a document the AI cannot
even retrieve/reference can never be marked sendable (sendability
implies retrievability; the reverse is not required - a document can be
retrievable for context but not sendable as a file).

Every FK from `business_documents` to `business_storage_sources` is
additionally scoped: application code creating this row must verify
`storage_source.business_id === business_id` before insert (belt), and
because `business_id` is denormalized (§3.2's rule), a future `CHECK`
constraint comparing the two via a trigger is possible if the review
wants that extra guarantee (suspenders) - proposed as an open decision,
not required for the initial migration.

### 3.4 `business_document_versions` — PROPOSED

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL FK → businesses(id) | **tenant boundary** |
| `document_id` | UUID NOT NULL FK → business_documents(id) | |
| `version_number` | INTEGER NOT NULL | sequential per document, starting at 1 |
| `checksum` | TEXT NOT NULL | SHA-256 of the raw uploaded bytes - same field name/shape already used by `whatsapp_media.sha256` |
| `content_hash` | TEXT NULL | SHA-256 of the *extracted plaintext*, set once parsing succeeds - lets a re-sync detect "file re-uploaded but content unchanged" (e.g. a Drive metadata-only touch) without re-chunking/re-embedding |
| `mime_type` | TEXT NOT NULL | raw, sender/provider-declared, stored verbatim (same "raw is real metadata, never mutated" rule from the Phase 1 MIME fix) |
| `mime_family` | TEXT NOT NULL | **normalized** via the existing `normalizeMimeType()`/`classifyMimeFamily()` helpers (`src/domain/whatsapp/mimeType.ts`, `mediaCompatibility.ts`) - this is the column every classification/parser-dispatch decision reads, never the raw `mime_type` |
| `file_size` | BIGINT NOT NULL | |
| `storage_reference` | TEXT NOT NULL | reuses the exact existing pattern in `localEncryptedMediaStorage.ts` (`buildStorageReference(businessId, sha256)` → business-scoped path, `EncryptionService.encryptBuffer` at rest) - no new storage primitive |
| `parser_status` | TEXT CHECK IN ('pending','parsing','parsed','failed','unsupported') | |
| `extraction_status` | TEXT CHECK IN ('pending','extracted','failed') | text extraction, distinct from parsing (parsing = "we understood the container format"; extraction = "we got usable text out of it") |
| `indexing_status` | TEXT CHECK IN ('pending','chunked','failed') | |
| `embedding_status` | TEXT CHECK IN ('not_applicable','pending','embedded','failed') | `not_applicable` is the expected default - see §11 |
| `source_provider` | TEXT CHECK IN ('upload','google_drive','dropbox') | denormalized from the parent document for convenient version-level queries |
| `external_file_id` | TEXT NULL | |
| `external_revision_id` | TEXT NULL | provider's per-file revision id, when available |
| `failure_reason` | TEXT NULL | honest, human-readable, never a raw stack trace with paths/secrets |
| `created_at` | TIMESTAMPTZ | versions are immutable once created - no `updated_at` |

Unique: `(document_id, version_number)`.

Old versions are **never deleted when a new version is created** - the
"replace Catalogue.pdf" flow inserts a new row and advances
`business_documents.current_version_id`; the old version row, its
chunks, and its embeddings persist until an explicit retention/purge
decision (§6) removes them.

### 3.5 `business_document_chunks` — PROPOSED

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL | **tenant boundary** |
| `document_id` | UUID NOT NULL FK → business_documents(id) | |
| `version_id` | UUID NOT NULL FK → business_document_versions(id) | |
| `sequence` | INTEGER NOT NULL | order within the version |
| `text` | TEXT NOT NULL | **PROPOSED to be encrypted at rest** via `EncryptionService.encryptField(businessId, text)` - the same envelope encryption already applied to WhatsApp message bodies. Chunk text is customer/business content, not meaningfully different in sensitivity from a message body. |
| `page_number` | INTEGER NULL | for paginated formats (PDF) |
| `section_title` | TEXT NULL | nearest heading, when the parser can detect one (see §10) |
| `char_start`, `char_end` | INTEGER NOT NULL | offsets into the version's extracted plaintext, for citation/debugging |
| `token_count` | INTEGER NULL | populated once an embedding provider's tokenizer has run over it |
| `checksum` | TEXT NOT NULL | SHA-256 of the chunk's own plaintext, before encryption |
| `created_at` | TIMESTAMPTZ | immutable |

Unique: `(version_id, sequence)`.

### 3.6 `business_document_embeddings` — PROPOSED, but see §11: recommend deferring actual use

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL | **tenant boundary - and see §7, the enforcement point, not merely a column** |
| `chunk_id` | UUID NOT NULL FK → business_document_chunks(id) | |
| `document_id`, `version_id` | UUID NOT NULL, denormalized | for scoped queries that don't need a chunk join |
| `embedding_provider` | TEXT NOT NULL | e.g. `'gemini'` - not hardcoded to one provider (see §11) |
| `embedding_model` | TEXT NOT NULL | e.g. `'text-embedding-004'` |
| `model_version` | TEXT NULL | provider's own version string, when they expose one |
| `dimensions` | INTEGER NOT NULL | |
| `vector` | **UNKNOWN / REQUIRES VERIFICATION** - see below | |
| `indexing_state` | TEXT CHECK IN ('pending','ready','stale','failed') | `stale` = the chunk's checksum changed since this embedding was generated |
| `generated_at` | TIMESTAMPTZ | |

Unique: `(chunk_id, embedding_model, model_version)` - re-embedding with a
new/updated model creates a new row rather than overwriting, so a
migration between embedding models/providers never has a window with no
working embeddings.

**`vector` column type is UNKNOWN / REQUIRES VERIFICATION**: migration
055's own comment (`knowledge_base_documents.sql`) states pgvector is
"not present in this project's postgres:16-alpine image." If that's
still true, this column would need to be `BYTEA` or `FLOAT4[]` with
application-level cosine-similarity, which is materially slower and
loses index-assisted ANN search - or the deployment's Postgres image
would need to change to one with pgvector, which is an infrastructure
decision outside this proposal's scope. **Recommendation (§11): do not
build real embeddings in Phase 2C/2F at all.** Extend the same
full-text-search approach `knowledge_base_documents` already uses
successfully (`tsvector`/GIN, `ts_rank`) to `business_document_chunks`
instead, and treat this table as a placeholder schema for a genuinely
later phase, only if lexical search proves insufficient. This directly
follows the explicit instruction "do not introduce a vector database
unless the current PostgreSQL architecture genuinely requires it," and
this codebase has real, working precedent for the lexical-only answer
already.

### 3.7 `business_document_access_policies` — PROPOSED

One row per business, company-level defaults for document actions.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL UNIQUE FK → businesses(id) | **tenant boundary**, one policy row per business |
| `requires_approval_for_send` | BOOLEAN NOT NULL DEFAULT true | fails safe: new businesses default to requiring human approval before any AI-initiated send |
| `allowed_send_channels` | JSONB NOT NULL DEFAULT '["whatsapp"]' | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

### 3.8 `business_document_send_requests` — PROPOSED

The AI's *intent* to send, and its resolution - see §12 for the full
gateway flow.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `business_id` | UUID NOT NULL | **tenant boundary** |
| `requested_by_agent_id` | UUID NULL FK → ai_agents(id) | set when an AI initiated the request |
| `requested_by_user_id` | UUID NULL FK → users(id) | set when a human initiated it directly |
| `document_id`, `document_version_id` | UUID NOT NULL | the version actually sent (never "whatever is current" - resolved once, at request time, so a document swap mid-approval can't silently change what gets sent) |
| `chat_id` | UUID NOT NULL FK → whatsapp_chats(id) | the *only* recipient-identifying value the AI ever supplies - never a phone number or business id, same rule already enforced for `update_lead` |
| `crm_contact_id` | UUID NULL | resolved server-side from `chat_id`, same `EntityOwnershipRegistry`-style resolution `LeadOwnershipResolver` already does |
| `channel` | TEXT CHECK IN ('whatsapp') | extensible later (email exists elsewhere in this app; not wired to document sends yet) |
| `status` | TEXT CHECK IN ('pending_approval','approved','denied','sent','failed') | |
| `idempotency_key` | TEXT NOT NULL | same idempotent-replay discipline as `update_lead`/outbound messages |
| `approved_by_user_id` | UUID NULL FK → users(id) | |
| `approved_at`, `sent_at` | TIMESTAMPTZ NULL | |
| `failure_reason` | TEXT NULL | |
| `created_at` | TIMESTAMPTZ | |

Unique: `(business_id, idempotency_key)`.

CHECK: exactly one of `requested_by_agent_id`/`requested_by_user_id` is
non-null.

## 5. Tenant-isolation model

Every table above carries `business_id`. The enforcement rule, stated
once as policy for every repository this phase eventually produces:

> Every repository method that accepts an object id also accepts (or
> already has, from the caller's authenticated context)
> `businessId`/`userId`, and the SQL itself filters on it -
> `getForBusiness`, `listForBusiness`, `createForBusiness`,
> `updateForBusiness`, `deleteForBusiness`. No `find(id)` variant is
> exposed for any table in this group. A cross-tenant id returns the
> exact same result as a nonexistent one.

This is not a new rule - it's the Phase 1 rule, applied from day one
instead of retrofitted. The difference from Phase 1: Phase 1 added
scoped methods *alongside* pre-existing unscoped ones (because those
repositories predate this discipline). Every Phase 2C repository is
proposed to be born with only the scoped methods - there is no unscoped
`find(id)` to ever accidentally call, because it will not exist.

## 6. AI capability model

No AI tool in this proposal ever takes a `businessId`, `document_id`
sourced from anywhere other than the server's own prior resolution, or a
raw storage reference. Concretely (all **PROPOSED**, none built):

- `search_company_knowledge(query: string)` - internally:
  `executionContext` (server-built, per 2B) → full-text search scoped to
  `business_id = executionContext.businessId AND ai_retrievable = true`
  → bounded, snippeted results. No document id ever appears in the tool's
  input schema.
- `get_customer_safe_document(documentDescription: string)` - the model
  describes *what it wants* ("the product catalogue"); the server
  resolves that description against `ai_retrievable`/`customer_visible`
  documents in its own business only, and returns the resolved
  document's safe metadata (never lets the model supply an id to fetch
  by).
- `request_document_send(documentDescription: string)` - see §12's full
  12-step gateway. The model never supplies a `document_id`.

This mirrors `update_lead`'s existing, already-verified shape exactly:
its zod schema has no `businessId` field (confirmed in the Phase 1
audit); the same constraint is proposed here as non-negotiable for every
new tool.

## 7. Document classification model

Modeled as **four independent boolean columns** on `business_documents`
(§3.3), not a single enum, because the requirement is explicitly that
these combine independently (a document can be retrievable-but-not-
sendable, customer-visible-but-not-AI-anything, etc.). `INTERNAL_KNOWLEDGE`
from the original 5-name list is modeled as the *implicit* state
`customer_visible = false` rather than its own column, since every
document is either customer-visible or internal by definition - a
separate flag would be redundant with (and could drift out of sync
with) `customer_visible`. This is flagged as an open decision (§20): the
alternative is a single `visibility` enum (`INTERNAL`, `CUSTOMER_VISIBLE`)
plus the three capability booleans, which reads slightly clearer but is
functionally identical. Recommend independent booleans; either works.

Default for every newly created document, before a human explicitly
changes it: **all four flags false** (fails closed - nothing is
AI-retrievable, AI-sendable, or customer-visible until a human opts it
in).

## 8. External-storage model

Covered fully in §3.1/§3.2. The one rule worth restating here: **an
OAuth connection grants zero document access by itself.** Only rows in
`business_storage_sources` - each an explicit, company-selected
folder/file - ever become eligible for `business_documents` creation. A
sync job that discovers files *outside* the selected sources takes no
action on them (not even logs their names, beyond what the provider's
own folder-listing API call already necessarily returns to enumerate
what's inside a selected folder).

## 9. Versioning model

Covered in §3.4. Old versions are retained (not overwritten) so that
(a) a bad re-upload/re-sync can be identified against history, and (b)
`current_version_id` gives every reader a single, unambiguous "what's
live right now" pointer without needing to compute "the latest version"
via a `MAX(version_number)` query at read time.

## 10. Parsing/indexing lifecycle (PROPOSED, no parser exists yet)

Chunking strategy, by `mime_family`:

- **PDF**: page-aware chunking - each chunk never spans a page boundary
  where avoidable, `page_number` populated, headings detected via
  font-size/style heuristics from the PDF's own structure (not blind
  N-character windows) to populate `section_title`. Tables extracted as
  a distinct chunk type preserving row/column structure as
  pipe-delimited or a structured JSON blob inside `text`, rather than
  flattened into unstructured prose that loses the table's meaning.
- **DOCX**: chunked by the document's own heading hierarchy
  (Heading 1/2/3 styles), so a chunk corresponds to a real section, not
  an arbitrary character count. Tables handled the same as PDF.
- **Plain text/CSV**: paragraph or row-group based.
- Fallback (any `mime_family` without a dedicated parser):
  `parser_status = 'unsupported'`, the document reaches `status='failed'`
  honestly - never a fabricated "parsed" state for content that was not
  actually understood.

## 11. Retrieval architecture

**Recommended: full-text search only for Phase 2C/2F**, extending
`knowledge_base_documents`' proven `tsvector`/GIN/`ts_rank` approach to
`business_document_chunks.text` (post-decryption, or via a
`pgp_sym_decrypt`-free approach - see open decision §20 on whether
chunk text can be searched while encrypted, which likely requires
decrypting server-side per query rather than at the database level,
same as message search already does for encrypted message bodies today
if applicable - **UNKNOWN / REQUIRES VERIFICATION**, need to confirm how
`whatsapp_messages` full-text search coexists with its own
`text_content` encryption, if it does, before finalizing this for
chunks).

Tenant isolation for retrieval is structural, never post-filtered:

```
-- what retrieval must look like
SELECT ... FROM business_document_chunks
WHERE business_id = $businessId   -- from executionContext, never the query
  AND to_tsvector('english', ...) @@ plainto_tsquery('english', $query)
ORDER BY ts_rank(...) DESC
LIMIT $n
```

never:

```
-- what it must never look like
SELECT ... FROM business_document_chunks
WHERE to_tsvector(...) @@ plainto_tsquery($query)
-- (then filter business_id in application code afterward)
```

If a future phase genuinely demonstrates lexical search is insufficient
(the same bar `knowledge_base_documents` was held to), real vector
search would need `business_id` as a **mandatory filter argument to the
similarity search itself** (e.g. pgvector's own `WHERE business_id = $1
ORDER BY embedding <=> $2`), never a post-hoc filter over the top-K
global results - stated as a hard requirement for that later phase, not
merely a preference.

## 12. AI document-send architecture

The 12-step gateway (**PROPOSED**, mirrors `guardToolInvocation`'s
existing, already-verified shape rather than inventing a new pattern):

```
request_document_send(documentDescription, chatId)
        │
        ▼
 1. Authenticate business (business row exists) - same check as agentGuard.ts:121
 2. Authenticate AI agent (exists, ACTIVE, belongs to this business) - same as agentGuard.ts:126
 3. Agent/tool capability check - same registered-tool-policy gate as every other tool
 4. Resolve chat → business/contact (never trust a model-supplied phone number) -
    same WhatsAppChatRepository.findByIdForBusiness pattern as Phase 1
 5. Resolve CRM contact from the chat (EntityOwnershipRegistry-style resolver,
    new "document" entityType alongside the existing "lead" one)
 6. Resolve the described document to a real business_documents row,
    scoped to business_id - if the model's description matches nothing
    real, or matches a document belonging to another business (which is
    structurally impossible given the scoped query, but stated for
    completeness): NOT_FOUND, not ACCESS_DENIED
 7. Confirm document.status = 'ready' AND ai_sendable = true
 8. Confirm business_document_access_policies.requires_approval_for_send
 9. If approval required: create business_document_send_requests row,
    status='pending_approval', STOP here - notify a human (existing
    notificationService pattern), return "pending approval" to the AI
10. If not required (or once a human approves): idempotency check
    against (business_id, idempotency_key)
11. Dispatch through the EXISTING whatsappOutboundMessageService.send()
    (media message type) - no new WhatsApp-send code path
12. Audit event written (§13) regardless of outcome - success, denial,
    and every intermediate failure all produce a row
```

The model never supplies: `document_id`, `business_id`, `chat_id`'s
underlying phone number, or a storage reference. It supplies a
description and a chat context (which is itself the same
already-authenticated `chatId` every other tool call already carries).

## 13. Audit model

**PROPOSED: extend the existing `security_audit_logs` table
(`src/db/migrations/.../003_or_similar_security_audit_logs.sql`),
not a new table.** This is real, existing, already business_id-indexed
infrastructure (`security_audit_logs_business_idx ON (business_id,
created_at DESC)`), already used for `ai_tool_invoked`/`ai_tool_denied`.
A new, parallel `business_document_audit_events` table would duplicate
that infrastructure for no benefit - the existing `event_type` CHECK
constraint is extended instead:

New event types: `document_accessed`, `document_search_performed`,
`document_send_requested`, `document_send_approved`,
`document_send_denied`, `document_sent`, `document_send_failed`,
`document_deleted`.

`raw_metadata` for a send event, following the existing pattern
(structural fields only, matching `agentGuard.ts`'s existing
`{toolName, risk, chatId, agentId}` shape):

```json
{
  "documentId": "...", "documentVersionId": "...",
  "classification": "ai_sendable", "chatId": "...",
  "agentId": "...", "channel": "whatsapp", "result": "SUCCESS"
}
```

**Never logged**: document text/contents, OAuth tokens, Authorization
headers, the recipient's phone number (the `chatId` UUID is sufficient
for correlation and is itself business-scoped), full file paths.

## 14. Threat model

| Threat | Mitigation | Status |
|---|---|---|
| AI supplies another business's id in a tool argument | No tool ever accepts businessId; every server-derived context comes from bearer-token/session lookup | EXISTING AND VERIFIED (general pattern, per 2B) / PROPOSED (extended to documents) |
| AI guesses/enumerates a document id from another business | Every document query is `WHERE business_id = executionContext.businessId AND id = $id` - cross-tenant id returns NOT_FOUND identically to nonexistent | PROPOSED |
| Compromised/malicious storage-provider account returns another tenant's files | Cannot occur structurally - each `business_storage_connections` row belongs to exactly one business's own OAuth grant; there is no code path that could attach one business's connection to another's sync job | PROPOSED |
| Document content contains prompt injection | Retrieved chunk text is always wrapped in the existing `<untrusted_data>` boundary (`wrapUntrustedData`, `aiReplyService.ts`) before reaching the model - same mechanism already protecting CRM notes/knowledge-base excerpts | EXISTING AND VERIFIED (mechanism) / PROPOSED (applied to document chunks) |
| Malicious MIME parameter smuggles an executable past classification | `mime_family` (normalized) is what every decision reads, never raw `mime_type` - same fix as the Phase 1 voice-note bug and the Phase 2A Sentinel bug | EXISTING AND VERIFIED (helper) / PROPOSED (applied here) |
| A document is deleted but remains AI-searchable | Deletion cascades to chunks/embeddings being excluded from every retrieval query immediately (soft-delete timestamp checked in the same WHERE clause as business_id) - see §15 | PROPOSED |
| Race: document deleted while a send is in-flight | `business_document_send_requests` resolves `document_version_id` once, at request creation; step 7 of §12 re-checks `status='ready'` at send time, not just at request time - a deletion between request and send is caught there | PROPOSED |
| Stale `cellGeneration` used to replay an old, now-revoked authorization | Same existing fencing check already proven in `openclawToolGateway.ts:146` | EXISTING AND VERIFIED |
| Wrong-tenant `chat_id` supplied to imply a different customer | Same existing `WhatsAppChatRepository.findByIdForBusiness` scoping from Phase 1 | EXISTING AND VERIFIED |

## 15. Adversarial test matrix (test design only - no tests exist, no schema exists to test against yet)

All 20 requested cases, with how each would be exercised once Phase 2C's
schema is approved and built:

1. Business A requests Business B's document → `getForBusiness(docId, businessB)` returns null for a real Business-A-owned id
2. Business A requests Business B's version → same, `business_document_versions.getForBusiness`
3. Business A searches Business B's chunks → full-text search query itself scoped by `business_id`; assert Business B's real, highly-relevant seeded content never appears in Business A's results (mirrors the Phase 1 funnel/media cross-tenant test style)
4. Business A retrieves Business B's embeddings → N/A if §11's recommendation (defer embeddings) is accepted; otherwise same pattern as #3
5. AI agent attempts cross-business document access → via `search_company_knowledge`/`get_customer_safe_document`, asserting the executionContext's businessId is the only one ever used regardless of query content
6. AI agent supplies a forged `businessId` → tool schemas have no such argument to forge (structural, not merely tested)
7. AI agent supplies a forged `documentId` → tools take descriptions, not ids; for any internal step that does resolve by id (e.g. §12 step 6), scoped query denies it
8. AI agent supplies a forged `cellId` → same existing bearer-token-derived resolution as `openclawAdapterService.test.ts:146`
9. Stale `cellGeneration` → same existing fencing test as `openclawToolGateway.test.ts:190`, re-verified against any document tool built on the same gateway
10. Wrong-tenant `chat_id` → same pattern as `openclawToolGateway.test.ts:116`, applied to §12 step 4
11. Revoked storage connection → a sync job must refuse to run against a `revoked_at IS NOT NULL` connection; test asserts no new `business_documents` rows are created from a revoked connection's sources
12. Deleted document → `getForBusiness` excludes `deleted_at IS NOT NULL` rows; retrieval excludes them; a pending send request against a since-deleted document is denied at send time (§12 step 7)
13. Deleted version → same pattern, at the version level; `current_version_id` must never point at a deleted version (enforced at the point a document is deleted - see §16)
14. Stale external file (provider reports it deleted) → `storage_sources.is_deleted_upstream = true` stops further sync; existing `business_documents` rows are marked `stale`, excluded from `ai_retrievable` results by an explicit status check, not just left as `ready`
15. Document prompt injection → chunk text wrapped in `<untrusted_data>` (§14); test asserts a forged instruction inside retrieved text never changes tool authorization/business boundary behavior, same style as the existing Context Trust Builder tests in `aiReplyService.test.ts`
16. Malicious MIME parameters → same `normalizeMimeType()` regression fixture pattern as `test/mimeType.test.ts`/`test/sentinel.test.ts`, applied to document classification
17. Unauthorized document send (not `ai_sendable`) → §12 step 7 denies; test seeds a real `ai_retrievable=true, ai_sendable=false` document and asserts `request_document_send` never dispatches it
18. Unauthorized customer recipient (chat belongs to a different business than the document) → §12 step 4/6 cross-check
19. Unauthorized team member (a human approver from a different business approving a pending send) → `approved_by_user_id` must resolve through the same business-membership check as every other cross-tenant-approval-shaped action in this app
20. Concurrent document deletion/send race → §12 step 7's re-check at send time, plus a DB-level check (e.g. the send dispatch's own UPDATE only proceeds `WHERE status='ready'` on the document at that instant, same optimistic-concurrency shape as `outboundDispatchWorker.ts`'s existing indeterminate-state handling)

Every one of these becomes a real, Postgres-backed test (no mocking the
tenant boundary itself) once the schema exists - consistent with how
every existing cross-tenant test in this codebase already works.

## 16. Migration strategy (for when 2C is approved - not happening now)

Proposed ordering, each its own migration file, matching this
codebase's existing one-concern-per-migration convention:

1. `business_storage_connections`, `business_storage_sources` (no
   dependents yet, safe to land first or last - genuinely order-
   independent of 2-6)
2. `business_documents`
3. `business_document_versions` (+ the deferred `current_version_id` FK
   on `business_documents`, added via `ALTER TABLE` after this migration,
   since it's a forward reference)
4. `business_document_chunks`
5. `business_document_embeddings` (**recommend skipping entirely per
   §11** unless the review disagrees)
6. `business_document_access_policies`, `business_document_send_requests`
7. `ALTER TABLE security_audit_logs` to extend the `event_type` CHECK
   constraint with the new document event types (§13)
8. `plan_entitlements` additions (`max_business_documents` or similar),
   mirroring the existing `max_knowledge_base_documents` pattern exactly

Every migration is additive (`CREATE TABLE`/`ALTER TABLE ... ADD
COLUMN`/`ADD CONSTRAINT`) - none touches existing rows in any
already-live table.

## 17. Rollback strategy

Every migration in §16 is reversible with a paired `DROP TABLE`/`ALTER
TABLE ... DROP COLUMN` (this codebase's migration runner does not
currently support down-migrations automatically per the existing
`ROLLBACK_PLAN.md` convention from Phase 0 - a rollback would be a new,
explicit down-migration file, same as every prior schema change in this
project). Because every table here is net-new (no existing table's
existing columns are altered destructively), a rollback at any point
before application code goes live carries zero data-loss risk to
anything outside this feature.

## 18. Performance considerations

- **Hundreds of businesses, thousands of documents each**: every query
  pattern in this proposal is `business_id`-first (either as the sole
  filter or the leading composite-index column), so table growth across
  many tenants doesn't degrade any single tenant's queries - standard
  multi-tenant B-tree index locality, same as every existing table in
  this schema.
- **Millions of chunks**: `business_document_chunks`'s GIN index (if
  full-text, per §11) partitions naturally by the `business_id`
  component of the composite index; a single business's chunk count
  (thousands, per the stated scale) stays well within what Postgres
  full-text search handles without special-casing.
- **Large catalogues (big individual documents)**: chunking bounds the
  per-retrieval read size regardless of source document size - a
  500-page catalogue is never read whole into an AI context, only its
  matched chunks (same bounded-snippet discipline
  `knowledgeBaseSearchService.ts` already applies, `SNIPPET_LENGTH`/
  `MAX_RESULTS`).
- Explicitly avoided: a separate vector database/service (§11), a
  message-queue-based ingestion pipeline beyond the existing BullMQ
  infrastructure this app already runs (ingestion jobs reuse
  `realtimeEventsQueue`-style workers, not a new queue technology).

## 19. Privacy/security considerations

| Concern | Approach |
|---|---|
| Encryption at rest | Document files: existing `EncryptionService.encryptBuffer` + `localEncryptedMediaStorage.ts` pattern (no new primitive). Chunk text: existing `encryptField` (§3.5). OAuth credentials: existing `encryptField`, never plaintext (§3.1). |
| Encryption in transit | Existing app-wide TLS assumption, unchanged by this proposal. |
| Provider OAuth scopes | Narrowest scope the provider allows for read-only file access (e.g. Drive's `drive.readonly` or per-file `drive.file` scope, which only grants access to files the user explicitly picks via the provider's own picker UI - **recommended over the broader `drive` scope specifically because it structurally enforces the "explicit selection" requirement from §8 at the OAuth layer itself**, not just in application logic). Exact scope choice deferred to Phase 2G design, flagged here as a strong preference. |
| Credential storage | §3.1 - encrypted reference only. |
| Retention | Documents/versions retained until explicit deletion (§6); no automatic time-based purge proposed for Phase 2C (a business's documents don't expire on their own) - retention policy is an explicit future business-facing setting, not a default behavior to invent now. |
| Deletion | §6/§15 #12-13. |
| Audit retention | Inherits whatever retention `security_audit_logs` already has (this proposal adds event types to an existing table/policy, not a new one). |
| PII / customer information | CRM contact linkage (§3.8) uses the existing `EntityOwnershipRegistry` resolution path, not a new PII store. |
| AI provider data handling | Chunk text sent to Gemini for retrieval/send-intent reasoning is subject to whatever data-handling terms already govern every other Gemini call this app makes (existing assumption, not newly introduced by documents) - **UNKNOWN / REQUIRES VERIFICATION**: whether Google's terms for the specific Gemini API tier this app uses differ for document-shaped content vs. chat text; this is a provider-policy question outside this codebase's control, not a technical control this proposal can resolve. |

## 20. Open design decisions (for your review, not resolved here)

1. **Classification model**: independent booleans (proposed, §7) vs. a
   `visibility` enum + capability booleans. Functionally equivalent;
   proposal favors booleans for simplicity.
2. **`business_id` denormalization mechanism** (§3.2): trust
   application-layer consistency (proposed default) vs. add a
   consistency trigger/CHECK. Recommend starting with the former and
   adding the latter only if Phase 2C's adversarial tests find a real
   gap.
3. **Chunk-text search vs. encryption** (§11): whether
   `business_document_chunks.text` can be both encrypted at rest and
   full-text-searchable without decrypting every row per query - needs
   to confirm how (or whether) `whatsapp_messages.text_content`'s
   existing encryption already coexists with any search over it before
   this is finalized. **Requires investigation before the migration is
   written**, not before this proposal.
4. **Embeddings** (§11): recommend not building `business_document_embeddings`
   for real use in this phase at all - ship full-text search only, matching
   `knowledge_base_documents`'s already-proven approach, and revisit
   embeddings only if lexical search demonstrably falls short, with an
   explicit, separately-approved decision to introduce whatever the
   pgvector-or-alternative story turns out to be at that time.
5. **Whether `knowledge_base_documents` (the existing plain-text-paste
   KB) is superseded by `business_documents`, kept as a parallel
   "quick note" path, or migrated into the new system** - not decided
   here; recommend keeping both independently for now (the existing one
   already works and has its own entitlement wiring) and revisiting once
   real usage data exists.
6. **Entitlements**: a `max_business_documents`-style limit, mirroring
   `max_knowledge_base_documents`, is assumed but not designed in detail
   here - straightforward to add via the existing `plan_entitlements`
   mechanism when the migration is written.

---

**Nothing in this document has been implemented.** Per instruction, this
stops here for review. No migration, no Google Drive/Dropbox code, no
document upload, no change to the OpenClaw gateway, and no change to any
existing tenant-isolation control has been made.
