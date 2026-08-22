# Business Execution Context — Security Model (Phase 2B)

Status: **design + verification only. No migration, no Google Drive, no
Dropbox, no document storage exists yet.** This document is the gate
Phase 2C's schema proposal must be reviewed against.

## 1. Audit — where each value actually originates today

| Value | Authoritative source (real file:line) | Can request/model/tool-call input override it? |
|---|---|---|
| `businessId` (web app) | `src/server/authMiddleware.ts:56-63` — resolved from the session cookie → `business_memberships` row lookup | No. `grep` for `req.body.businessId`/`req.query.businessId`/`req.params.businessId` across `src/server/*.ts` returns zero matches. |
| `businessId` (AI reply pipeline) | `src/services/whatsappConnectionService.ts:556` — set once, from the connected WhatsApp account's own `business_id` row, at connection bootstrap | No. Customer message text only ever fills `queryText`; no code path lets message content or model output set `businessId` (confirmed in the Phase 1 audit). |
| `businessId`/`cellId` (OpenClaw/MCP) | `src/services/openclawAdapterService.ts` — resolved from a bearer-token **hash lookup** against `openclaw_fleet_cells`, never from the request body | No. `test/openclawAdapterService.test.ts:146` (`ignores a businessId/cellId the request body tries to claim - only the authenticated token's identity is ever used`) and `test/openclawMcpServer.test.ts:137` prove this with a real stolen/foreign token. |
| `userId` | `src/server/authMiddleware.ts` — same session lookup as `businessId`; both come from the one authenticated `AuthContext` | No separate override path exists - it is the same session resolution as businessId. |
| `cellGeneration` | **Authoritative value**: `cells.generation` column, read fresh from Postgres inside `openclawToolGateway.ts:146` at the moment of the call. **Request-supplied value**: `input.cellGeneration`, submitted by the cell as a fencing *claim*, and used only for one purpose - equality-compared against the real row and the whole request denied on any mismatch (`cellGeneration: number; ... if (cell.generation !== input.cellGeneration) → denyAndAudit('stale cell generation ... fenced out')`). It is never trusted as truth, only checked against truth. | Cannot broaden or replace the context - a mismatch can only ever narrow the outcome to DENY, never approve a stale claim. Proven by `test/openclawToolGateway.test.ts:190` and `test/openclawMcpServer.test.ts:190`. |
| permissions / role | `src/domain/auth/permissions.js` + `src/server/authMiddleware.ts:59` — `role: result.membership.role`, read from the session-resolved `business_memberships` row | No. Never accepted as a request field; `requirePermission()` reads only `auth.role` from the already-built `AuthContext`. |
| authenticated identity (actor) | Web: session cookie. AI/OpenClaw: bearer-token hash lookup. Never a request field, header claim, or tool-call argument. | `test/openclawToolGateway.test.ts:207` (`DENIES a prompt-injection-style claimed identity carried in the request fields - actor comes only from chatId`) proves this for the one place an actor identity could plausibly be smuggled in. |

**Finding:** every value the eventual document system will need already has exactly one authoritative, server-derived source in this codebase, and every override attempt that could plausibly be tried today is both structurally blocked and covered by a real, passing test. Nothing here required a code change — this is the actual, current state, confirmed by re-running the full OpenClaw/agentGuard test suite fresh (70/70 passing, see verification section).

## 2. The invariant (adopted, verbatim)

> Every AI execution has exactly one authoritative business context. Every
> document operation, retrieval operation, storage operation, and outbound
> document action must execute inside that context. No model-visible
> argument can establish, replace, or broaden the context.

This is now a standing rule for all future work in this codebase (Phase
2C onward), not just a Phase 2B statement — it belongs alongside the
Phase 1 rule already in `CHANGELOG_SECURITY.md` ("no business boundary is
enforced by prompt instructions alone").

## 3. Prohibited flows — tested today vs. deferred to Phase 2C

| Prohibited flow | Status | Evidence |
|---|---|---|
| AI supplies another `businessId` | **Closed, tested today** | `test/openclawAdapterService.test.ts:146`, `test/agentGuard.test.ts:70` (forged/stale businessId) |
| AI attempts to act as another business's agent/cell | **Closed, tested today** | `test/agentGuard.test.ts:94` (cross-tenant agent), `test/openclawMcpServer.test.ts:137` (stolen token) |
| AI supplies another business's *entity* id (the closest existing analog to a future documentId — a lead) | **Closed, tested today** | `test/openclawToolGateway.test.ts:106` (`DENIES when OpenClaw attempts another tenant's lead`) |
| AI attempts to act via a chat/customer with no real relationship to the target entity | **Closed, tested today** | `test/openclawToolGateway.test.ts:116` |
| stale `cellGeneration` | **Closed, tested today** | `test/openclawToolGateway.test.ts:190`, `test/openclawMcpServer.test.ts:190` |
| wrong-tenant `chat_id` / claimed identity in request fields | **Closed, tested today** | `test/openclawToolGateway.test.ts:207` |
| quarantined cell still attempting a request | **Closed, tested today** | `test/openclawToolGateway.test.ts:198`, `test/openclawMcpServer.test.ts:200` |
| AI supplies another business's **storage reference** | **N/A — no storage-reference-bearing tool exists yet.** Deferred to Phase 2C/2F; the pattern it must inherit (never trust a caller-supplied reference; resolve internally from the authenticated context) is already proven for cells/tokens above. |
| AI supplies another business's **documentId**, or a documentId obtained indirectly through model context | **N/A — no `business_documents` table exists yet.** Deferred to Phase 2C. The exact pattern to reuse is already proven: `getForBusiness(id, businessId)`-shaped lookups (Phase 1) + the entity-ownership-resolver pattern (`entityOwnershipRegistry.ts`) that already backs `update_lead`. |
| AI attempts to search another business's knowledge | **N/A — no knowledge-search tool exists yet.** Deferred to Phase 2D. Rule adopted now (section 5): the search layer itself takes only the authenticated context, never a business identifier as an argument. |
| AI attempts to send another business's document | **N/A — no send capability exists yet.** Deferred to Phase 2E, which must use the same gateway pattern as `guardToolInvocation`/`openclawToolGateway`, not a new one. |
| manipulated storage-provider IDs | **N/A — no storage connector exists yet.** Deferred to Phase 2F (explicitly not started). |

Every flow that has a real analog in the current codebase is closed and
covered by a passing test today. Every flow marked N/A cannot be tested
honestly before the schema it depends on exists — writing a test against
code that doesn't exist would be fabricated verification, not real
evidence. Phase 2C's schema proposal is reviewed *before* any migration
specifically so these deferred rows can be closed with real tests as soon
as the tables exist, not bolted on afterward.

## 4. Repository scoping rule (standing policy for Phase 2C+)

Restating the Phase 1 pattern as a mandatory rule for every future
document-related repository — not optional, not "when convenient":

```
getForBusiness(documentId, businessId)
listForBusiness(businessId)
createForBusiness(businessId, ...)
updateForBusiness(documentId, businessId, ...)
deleteForBusiness(documentId, businessId)
```

Never `find(documentId)` followed by an application-level `businessId`
check. The SQL query's own `WHERE ... AND business_id = $n` is the
boundary, not a JavaScript `if`. A cross-tenant id must return the exact
same "not found" result as a genuinely nonexistent one — this codebase's
own repositories already follow this (Phase 1), and it will not be
diluted for documents.

## 5. AI capability boundary (naming rule for Phase 2D+)

The AI-facing surface must expose **capabilities**, never **database
access**. Concretely: no future AI tool schema may declare a `businessId`
(or `business_id`) argument, ever — the same rule the one AI tool that
exists today (`update_lead`) already follows (confirmed:
`aiToolPolicy.ts` has no `businessId` field in any tool schema, per the
Phase 1 audit). The eventual tools are named for what they let the AI
*do*, not what they let it *reach*:

- `search_company_knowledge` (never `search_business` / `search_knowledge_base(businessId, ...)`)
- `get_company_document` (never `get_document_by_id` / `list_all_documents`)
- `request_send_document` (never `send_document(documentId, businessId)`)

Each of these, when built, resolves its own businessId internally from
the same authenticated context this document audited — the model never
sees, receives, or supplies it.

## Verification gate for this phase

- Typecheck: clean.
- Full existing suite: passing (see the accompanying commit for the
  exact count at time of landing).
- Every prohibited flow with a real analog in today's codebase:
  re-run and confirmed passing fresh (`openclawToolGateway.test.ts`,
  `openclawAdapterService.test.ts`, `openclawMcpServer.test.ts`,
  `agentGuard.test.ts`, `openclawCellService.test.ts`,
  `openclawSecurityWatcherService.test.ts` — 70/70).
- No migration written. No Google Drive/Dropbox code. No document
  storage implementation. Phase 2C begins with a schema **proposal**
  only, for review before any table is created.
