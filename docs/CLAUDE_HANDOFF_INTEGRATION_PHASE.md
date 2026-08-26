# WhatchatAI + Buzz + OpenClaw Integration Phase Handoff

## Current branch

Continue work on:

`build/property-operations-os`

Do not merge this branch into `main`, `phase-2-ai-repair`, or `openclaw-cell-runtime` until the full audit is complete.

## What has already been built

WhatchatAI remains the customer-facing product and system of record. The current product foundation includes WhatsApp/Baileys ingestion, PostgreSQL persistence, Redis/BullMQ, authentication, CRM, AI context, security controls, realtime updates, outbound dispatch, and existing agent routing.

A new platform layer has been added without replacing that foundation.

The platform contracts include:

- CommunicationEvent
- OperationalEntity
- AgentCapability
- AgentTask
- ActionRequest
- AuditEvent
- AIProviderAdapter
- AgentRuntimeAdapter
- AgentExecutionResult

The intended invariant is:

> WhatchatAI owns reality. Buzz and OpenClaw execute delegated agent work.

## Runtime and intelligence architecture

There are three separate concerns:

1. WhatchatAI business/control plane
   - tenants
   - users
   - permissions
   - business data
   - communication
   - operational graph
   - policies
   - approvals
   - actions
   - audit

2. AI Gateway
   - provider-independent model interface
   - provider selection and fallback
   - modality capability checking
   - structured output validation
   - cost/usage visibility

3. Agent execution runtimes
   - Buzz through an ACP adapter
   - OpenClaw through its existing authenticated tool gateway
   - additional runtimes can be added later behind the same interface

Buzz is not the business database and does not get direct authority over WhatchatAI's tenant data or outbound WhatsApp socket.

## Buzz findings that matter

Buzz's `buzz-agent` exposes an ACP stdio execution path. It supports agent execution and tool-oriented workflows, but its current ACP capability set is not a reason to move all multimodal processing into Buzz.

The current design therefore keeps multimodal interpretation in WhatchatAI's AI Gateway and delegates bounded agent execution to Buzz.

Buzz's workflow/audit concepts are useful, but WhatchatAI must remain the authoritative authorization and approval boundary.

Do not assume Buzz's current approval implementation is production-complete. WhatchatAI's approval mechanism should remain independently controlled.

## OpenClaw findings that matter

WhatchatAI already has an authenticated OpenClaw cell/tool gateway. Authentication is separated from normal browser session authentication and cell identity is resolved from the authenticated record rather than trusted request-body identity.

Do not weaken this boundary. Do not allow an OpenClaw cell to choose another tenant, cell, or generation through request fields.

## Property Operations foundation already added

A first Property Operations module exists with:

- properties
- units
- assets
- vendors
- incidents
- work orders
- property knowledge
- maintenance intake

The first commercial skill is:

`property.maintenance.triage`

It is intentionally governed by capability and policy checks.

The first deterministic maintenance safety policy handles strong signals for:

- fire/smoke
- gas/fuel
- electrical danger
- uncontrolled water
- security threats

The AI must not downgrade a deterministic life-safety escalation.

If AI output fails schema validation, the system must fail closed and route to human review rather than guessing.

## Action boundary

All meaningful side effects must follow:

`ActionRequest -> authorization -> policy -> approval where required -> execution -> verification -> audit`

Agents do not directly send WhatsApp messages, modify tenant records, issue refunds, modify leases, or dispatch unapproved vendors.

The existing WhatchatAI outbound dispatcher remains the controlled path for outbound WhatsApp delivery.

## Audit boundary

Audit records are intended to be tamper-evident. The chain includes the tenant, actor, correlation information, payload and previous hash.

When extending the system, preserve enough information to answer:

- what happened
- who/what caused it
- what the agent saw
- what it decided
- what policy allowed or rejected
- whether approval was required
- what was actually executed
- what result occurred

Do not claim cryptographic immutability unless the storage architecture actually provides it. At this phase the intended property is tamper evidence plus verification.

## Skills and modules

Skills are governed capabilities, not arbitrary prompts.

A skill can define:

- version
- required tools
- capabilities
- allowed actions
- forbidden actions
- approval requirements
- risk ceiling
- supported channels
- enabled state

Modules are commercial/product packages. The first module is Property Operations. Future modules can include Voice Operations, Sales Operations, Document Operations, field service, and other vertical packs.

Do not create one codebase per vertical. Reuse platform primitives and add domain-specific skills, entities, policies, workflows, tools and UI.

## Current known integration gap

The Property Operations router is implemented but must be safely mounted into the main Express server without disturbing the large existing server registration file.

Before modifying `src/server/index.ts`, inspect the exact current route registration point and preserve all existing middleware ordering, auth behaviour, OpenClaw routes, workers, health endpoints and static serving.

Avoid large blind replacement of `index.ts`.

## Current known implementation risks to inspect

1. Property Operations router should not reach into private service fields such as `operations['repository']`. Expose proper service methods instead.
2. Action idempotency must be based on a stable logical operation key. Do not append random UUIDs to a key that is supposed to deduplicate retries.
3. Property Operations database writes must consistently enforce business/tenant ownership through the repository layer, not only route parameters.
4. Generic module entitlement code should not access private fields through bracket notation. Refactor toward explicit public entitlement APIs.
5. The operational graph should eventually support reservations, guests/contacts, assets, procedures/knowledge and vendors without breaking existing records.
6. AI outputs are untrusted. Validate all structured output before making decisions.
7. Never trust tenant, business, property or cell identifiers supplied by an agent/runtime when authenticated server-side identity already exists.
8. Preserve the existing WhatsApp connection/pairing implementation unless a future migration is explicitly planned and tested.
9. The commercial WhatsApp path should prefer official Meta APIs. Do not introduce unofficial transport into the commercial architecture merely because an internal development path uses Baileys.
10. Do not automatically enable new agent runtimes or skills in production.

## Next phase: Integration

Complete these in order.

### 1. Safe Express integration

Mount the Property Operations routes under a stable API prefix and verify authentication and permissions are enforced for every route.

### 2. Database integration hardening

Review and correct migrations, foreign keys, indexes, tenant scoping, update triggers, and repository methods.

### 3. Approval persistence

Create a real persistent approval workflow in PostgreSQL. Approval must be a WhatchatAI control, not delegated to Buzz/OpenClaw.

### 4. Action executor layer

Register only explicitly approved action executors. Every executor must validate tenant context, payload schema and authorization before performing a side effect.

### 5. Communication integration

Build the canonical conversion from existing inbound WhatsApp/message events to `CommunicationEvent` without changing the existing ingestion semantics.

### 6. Property context resolution

Resolve business, guest/contact, property, unit, reservation and asset from trusted database state before creating an `AgentTask`.

### 7. Maintenance triage integration

Connect the deterministic maintenance policy and AI triage service to a synthetic end-to-end path first.

Do not connect live customer traffic until the end-to-end integration and regression suite is green.

### 8. Multimodal pipeline

Support the canonical communication model for text, photo, voice note, document, video and calls. Use provider capability checks and enforce size/type limits.

### 9. Human handoff UI

Expose pending approvals, escalations, incident context and the audit trail in the dashboard.

### 10. Full audit

After integration, stop feature work and perform a hostile audit covering security, tenant isolation, data integrity, concurrency, retries, queue behaviour, AI safety, provider failure, runtime failure, media handling, cost amplification, and UI authorization.

## Testing standard

The final test matrix should include at least:

- normal maintenance request
- photo-based request
- voice-note request
- video request when feature enabled
- document request
- dangerous electrical request
- gas/fire request
- uncontrolled water request
- prompt injection attempt
- cross-tenant context attempt
- cross-tenant ActionRequest
- agent forbidden action
- excessive risk action
- missing provider
- provider timeout
- provider malformed JSON
- Buzz unavailable
- OpenClaw unavailable
- duplicate message
- duplicate ActionRequest
- approval rejection
- approval replay
- partial execution
- audit tampering
- worker restart/retry

## Product goal

The first customer-facing vertical remains:

**WhatchatAI Property Operations for luxury short-term rentals and villa managers.**

The first commercial workflow remains:

**WhatsApp-first multimodal maintenance triage.**

The architecture must still support future bolt-ons through the same core platform.

## Non-negotiable rule

Build large, but release small.

Do not let the breadth of the future platform weaken the reliability of the first commercial workflow.
