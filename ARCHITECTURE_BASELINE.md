# ARCHITECTURE_BASELINE.md

Real, traced execution paths as they exist in the repository today (commit
`e7a2327` / audit branch `audit/phase-0-safety-baseline`). This documents
what the code actually does, verified by reading it during this session and
prior work in it - not what filenames or comments imply. See
`docs/ARCHITECTURE.md` and `docs/database/` for deeper prior documentation;
this file is the audit-specific trace required by Phase 0.

## Inbound WhatsApp -> AI -> outbound (the real path)

```
Baileys socket event (messages.upsert)
  -> whatsappConnectionService (owns the live socket, session dir)
  -> whatsappMessageIngestionService (classifies event, builds job payload)
  -> incomingMessagesQueue (BullMQ, Redis-backed)
  -> incomingMessagesWorker (separate process: `npm run dev:worker` / `start:worker`)
       -> runSentinel() [src/security/sentinel/sentinel.ts]
            Stage 1: heuristicShield.ts (regex-based fast reject)
            Stage 2: aiSentinel.ts (Gemini classification, only if stage 1 passes)
       -> whatsappMessagePersistenceService (real Postgres write, inside a transaction;
          message bodies encrypted at rest via encryptionService before storage)
       -> routeInboundMessage() [agentRoutingService.ts] selects an AiAgentRecord
          for the business (or resolves "no agent" -> visible notification,
          never a silent drop - a specific fix made earlier this session)
       -> gatherAiHandoffContext() [aiContextGathererService.ts] - a single
          Promise.all() gathering CRM contact, knowledge-base search,
          conversation history, and TimeContext concurrently
       -> generateAiReply() [aiReplyService.ts] - builds the system
          instruction, calls Gemini via geminiClient.ts with a real
          get_current_time function-calling tool (added this session),
          falls back to Goose (gooseService.ts) only after a genuine
          Gemini failure, never fabricates a reply
       -> whatsappOutboundMessageService -> outboundMessagesQueue -> outboundDispatchWorker
       -> whatsappConnectionService's Baileys socket sends the real message
```

Human takeover: `whatsapp_chats.ai_mode` (`AI_ACTIVE` / `AI_PAUSED` /
`HUMAN_TAKEOVER`) gates whether `generateAiReply` is ever invoked for a
given chat - checked before the AI path runs, not after.

## Tenant model / isolation

- Single Postgres schema, tenant column `business_id` on every tenant-scoped
  table (confirmed: 26 of 39 repositories issue explicit `WHERE business_id
  = $1`-shaped queries; the remaining repositories are either genuinely
  global lookup tables or receive their scope from a caller that already
  filtered by business).
- HTTP entry point: `requireWorkspaceContext` middleware
  (`src/server/index.ts`) resolves `businessId`/`whatsappAccountId` from the
  authenticated session (`res.locals.workspaceContext`) - **not** from any
  client-supplied identifier in the request body or query string. A route
  handler that trusted a client-supplied `businessId` instead of
  `res.locals.workspaceContext` would be a tenant-isolation defect; this
  audit did not exhaustively verify every one of the ~150+ routes in
  `src/server/index.ts` for that pattern (flagged as an open item below,
  not confirmed clean or confirmed broken).
- `requirePermission(...)` layers role-based checks (`BusinessRole`:
  `OWNER`/`ADMIN`/`MANAGER`/`SUPERVISOR`/`AGENT`, per
  `business_memberships`) on top of tenant scoping for mutating routes.
- The AI reply path never receives a client-supplied tenant identifier: it
  is invoked entirely from the queue worker, using the `businessId` that
  was already resolved and persisted at ingestion time from the Baileys
  session's own owning account - not from anything in the WhatsApp message
  content itself.

## Authentication

- Session-cookie based (`authMiddleware.ts`), Argon2id password hashing
  (`authService.ts`), sessions persisted in Postgres with revocation support
  (`Settings -> Security -> Sessions`).
- A separate, unrelated "screen lock" mechanism (`securityLockService.ts`,
  PIN-based) exists purely as a local privacy screen over an already
  -authenticated session - it is not a second authentication factor and does
  not gate API access, only the frontend UI's visibility of message
  content. Its `AlertNotifier` component deliberately shows only a
  non-PII ordinal + urgency tier on the lock screen (`securityAlertService.ts`,
  documented "Zero-Leak Rule" in that file's own comments), specifically
  because it can be visible to an unauthenticated viewer glancing at a
  locked screen.

## AI provider surface (today)

Exactly two providers exist:

1. **Gemini** (`@google/genai`, primary) - `geminiClient.ts` is a bare
   singleton factory around `GoogleGenAI`. No tool-permission model, no
   per-tool risk classification, no agent-versioning table exists yet. The
   one tool registered (`get_current_time`, added this session) is
   read-only, takes no arguments, and is bounded to one function-call round
   trip per reply - there is no generalized "AI proposes arbitrary
   action" pipeline in place; each capability the AI can invoke is
   currently hand-wired one at a time into `aiReplyService.ts`.
2. **Goose** (`gooseService.ts`, optional failover) - a plain HTTP contract
   (`GET /health`, `POST /generate`) against a URL the operator configures;
   `.env.example` explicitly documents that a stock Goose install does not
   implement this contract and that Goose sharing Gemini as its own
   backing LLM defeats the point of failover.

No OpenClaw, DSPy/GEPA, or other agent framework exists in the codebase.
Sections 6-10 and 18-58 of the production-safety directive describe a
target-state zero-trust AI-agent model (permission tiers, structured
intent pipeline, per-agent execution context, isolated containers) that
**does not exist today** - it would be new architecture, not a hardening
of something already present, and per the directive's own Phase ordering
this is explicitly deferred past Phase 0.

## Queues / workers (BullMQ + Redis)

Seven queues, each with a dedicated worker, all defined under
`src/queue/`: `incomingMessagesQueue`, `outboundMessagesQueue`,
`scheduledStatusesQueue`, `funnelAdvanceQueue`, `emailSendQueue`,
`realtimeEventsQueue`, `messageRevocationsQueue`. All scheduling observed
in this codebase computes delays as `targetTimestamp.getTime() -
Date.now()` and stores `TIMESTAMPTZ` (UTC-on-the-wire) columns - this
session's own prior work (the time-intelligence feature) extended this
pattern for funnel WAIT steps without touching the underlying queue
infrastructure.

## Media

`whatsapp_media` table + `localEncryptedMediaStorage.ts`: media is
downloaded by a dedicated worker job, encrypted at rest
(`encryptionService.ts`, AES-256-GCM envelope encryption with a Redis-
cached DEK), and served only through an authenticated `GET /api/media/:id`
endpoint - never a public/unauthenticated file path.

## Security-relevant infrastructure that already exists

- Two-stage Sentinel (heuristic + AI classification) gates every inbound
  message before persistence/AI processing.
- Field-level encryption for message bodies and media at rest, with a
  documented local master key (`MASTER_ENCRYPTION_KEY`) - not a cloud KMS
  (explicitly noted in `.env.example` as a known simplification).
- `security_audit_logs` table exists and is written to by several services
  (funnel/campaign lifecycle events, lock/unlock attempts) - this is a
  real, if partial, audit trail, not the comprehensive AI-tool-invocation
  audit log the directive's Section 7/33 describes (which does not exist).

## Known gaps relative to the directive's target state (not defects in
   what exists - absence of not-yet-built architecture)

- No AI tool permission/risk-classification framework (READ/WRITE/SEND/
  HIGH_RISK/SYSTEM) - today, capabilities are individually hand-wired
  function calls with no generalized policy gate.
- No per-agent execution context (`tenant_id`/`business_id`/`agent_id`/
  `allowed_tools`/`risk_level`/`expiration`) structure - the one existing
  tool call is scoped implicitly by which business's `aiReplyService`
  invocation it runs inside, not by an explicit, application-enforced
  context object the model cannot forge.
- No prompt-injection-specific defenses beyond what emerged naturally from
  this session's own security-conscious build process (e.g. the
  `get_current_time` tool is read-only and the system prompt tells the
  model trusted TimeContext must never be overridden by message content -
  this is instruction-level, not a structural enforcement layer).
- No container boundary of any kind exists yet (see CURRENT_STATE.md §7).
- No scheduled security-scan job exists.
- No knowledge-base retrieval with tenant-scoped permissions beyond the
  existing `searchKnowledgeBase()` call already gated by
  `businessId` in `aiContextGathererService.ts`.
