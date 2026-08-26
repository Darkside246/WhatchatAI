# Claude Handoff - WhatchatAI Property Operations OS

## Purpose

This file is a plain-English handoff for the next AI engineering agent. It explains what has been done on the `build/property-operations-os` branch, why it was done, what must not be changed casually, the current limitations, and the next engineering phase.

Do not treat this document as marketing material. Treat it as an engineering continuity note.

## The project

WhatchatAI is the customer-facing SaaS product. Buzz and OpenClaw are separate execution technologies that are being evaluated and integrated behind controlled interfaces.

The core architectural rule is:

**WhatchatAI owns reality; delegated runtimes execute agent work.**

WhatchatAI owns tenant identity, users, permissions, business records, conversations, WhatsApp connectivity, the operational graph, policies, approvals, business actions, billing and the authoritative audit history.

Buzz is useful as an agent/workflow execution substrate. OpenClaw is an existing isolated agent-cell integration. Neither should become the system of record, the owner of tenant authorization, or the direct owner of the WhatsApp connection.

## Branch

All current work is being done on:

`build/property-operations-os`

This branch was created from the more advanced `openclaw-cell-runtime` branch. Existing branches such as `main`, `phase-2-ai-repair`, and `openclaw-cell-runtime` must remain untouched unless a deliberate merge is later requested.

## What has already been built

### 1. Platform contracts

The branch now contains canonical typed and runtime-validated contracts for:

- CommunicationEvent
- OperationalEntity
- AgentCapability
- AgentTask
- ActionRequest
- Approval
- AuditEvent
- AgentExecutionResult
- AgentRuntimeAdapter
- AIProviderAdapter
- AI provider media inputs

These contracts are intended to be the stable seams between the product, AI gateway, agent runtimes, and action system.

### 2. AI gateway

A provider-neutral AI gateway and provider registry have been introduced. Providers are selected by declared capability and policy rather than by direct calls scattered throughout the product.

The goal is to support multiple providers and eventually cheaper/specialized models without changing business workflows.

The gateway is deliberately fail-closed around unsupported modalities and bounded input/output sizes.

### 3. Buzz adapter

A Buzz ACP adapter has been added. It uses Buzz's actual ACP/stdin/stdout execution interface rather than inventing a different protocol.

The adapter treats agent output as untrusted data. Buzz does not receive direct PostgreSQL credentials, tenant authority, or a direct WhatsApp socket.

The intended flow is:

WhatchatAI creates an AgentTask -> runtime adapter delegates execution -> agent result returns -> WhatchatAI policy evaluates any ActionRequest.

### 4. OpenClaw boundary

The existing OpenClaw cell gateway remains in place. Its authentication is separate from browser sessions and is based on an authenticated cell record and callback token. The request body must not be trusted for tenant/cell identity.

Do not weaken that boundary just to make integrations easier.

### 5. Operational Graph foundation

The property domain has been started with persistent structures and services for:

- Business-scoped properties
- Units/villas
- Assets/equipment
- Vendors
- Reservations
- Incidents
- Work orders
- Property/asset knowledge

The long-term concept is an Operational Graph. Property management is the first domain, not the final limit of the platform.

### 6. Skill Registry

A governed Skill Registry exists. Skills are versioned and carry:

- capabilities
- required tools
- allowed actions
- forbidden actions
- human approval requirements
- maximum risk level
- supported channels
- enabled state

The first domain capability is:

`property.maintenance.triage`

It is intentionally disabled until the integration and safety checks are proven.

### 7. Action and policy layer

An ActionRequest is not executed simply because an agent asked for it.

The flow is:

ActionRequest -> tenant check -> capability check -> risk check -> policy -> approval when required -> executor -> audit.

High-risk and explicitly approval-gated actions must not silently become automatic.

### 8. Tamper-evident audit foundation

The new audit layer records event contents and a SHA-256 hash chain. Tests cover deliberate tampering and chain verification.

The audit layer is intended to become the forensic trail for agent decisions, approvals, and actions.

Do not call this an absolute immutable ledger unless the final persistence architecture actually provides the required guarantees. For now, the correct description is tamper-evident audit chain.

### 9. Property maintenance safety policy

There is a deterministic safety classifier for maintenance communications. Safety signals are evaluated before AI and can force human escalation.

Examples include:

- fire or smoke
- gas/fuel concerns
- dangerous electrical conditions
- uncontrolled water
- security threats

The AI must not be allowed to downgrade a deterministic life/safety escalation.

### 10. Maintenance triage agent foundation

A bounded maintenance triage service exists. It can use deterministic rules and the AI gateway to classify property maintenance messages.

AI output is schema-validated. Invalid AI output falls back to human review rather than guessing.

The service can produce bounded ActionRequests such as creating a work-order request or asking for human review.

### 11. Property Operations API/UI foundation

A property operations API router and initial React workspace page have been created.

The API is intended to expose properties, units, assets, vendors, incidents and property knowledge.

The UI is a starting point, not the finished commercial experience.

## Existing WhatchatAI functionality that must be preserved

WhatchatAI already has significant production-oriented infrastructure. Do not replace it casually.

Preserve:

- React/Vite frontend architecture
- Node/Express backend
- PostgreSQL as authoritative application data store
- Redis/BullMQ asynchronous processing
- Baileys WhatsApp connection and its carefully handled JID identity model
- Existing inbound message processing
- Existing outbound dispatcher as the only live WhatsApp send path
- Authentication and workspace isolation
- Existing AI context gathering where still appropriate
- Existing security Sentinel / AI security controls
- Existing realtime WebSocket layer
- Existing media encryption/storage controls
- Existing plan and entitlement enforcement

The commercial architecture must not give a new agent runtime direct access to the WhatsApp socket.

## Communication model

The product eventually needs one canonical CommunicationEvent across:

- WhatsApp text
- WhatsApp images
- WhatsApp voice notes
- WhatsApp video
- WhatsApp documents
- voice calls
- SMS
- email
- web input

The communication layer records what actually arrived. The AI layer interprets it later.

This distinction is important. AI must not redefine the underlying business event.

## Property Operations MVP

The first commercial vertical is luxury short-term rental and villa/property management, initially suitable for Barbados and then exportable globally.

The first workflow is:

Guest message -> identify property/guest/context -> deterministic safety checks -> AI interpretation when appropriate -> request missing information/media -> create incident -> policy evaluation -> human approval where required -> work-order/contractor workflow -> guest response -> audit.

The first use case is multimodal maintenance triage over WhatsApp.

The commercial hypothesis is that high-end villa managers have substantial after-hours unstructured communication and that fast, safe triage can reduce unnecessary emergency call-outs and operator workload.

This is still a hypothesis to be validated with real operators. Do not turn assumptions about savings, message volume, guest behavior, or willingness to pay into facts without customer evidence.

## Why Barbados matters

Barbados is the initial development and customer-research environment because the target property/villa sector is internationally oriented and communication-heavy.

The goal is not to make a Barbados-only product. The goal is to use local operators as a demanding pilot group, capture real operational evidence and then export the validated workflow to markets such as the United States, Canada and the United Kingdom.

Do not design the core data model around Barbados-specific assumptions.

## Skills repository

The `awesome-agent-skills` repository is treated as a source of reference and candidate capabilities, not as a package to blindly import.

Any external skill must be reviewed, versioned, scoped, permissioned and tested before being allowed into production.

A skill is a governed capability, not merely a prompt file.

## Important architecture boundaries

### WhatchatAI owns

- tenant identity
- users and roles
- permissions
- business data
- communication records
- operational graph
- policies
- approvals
- action authorization
- billing and entitlements
- authoritative audit history
- customer-facing UI

### Buzz/OpenClaw own

- delegated agent execution
- workflow execution where explicitly delegated
- tool orchestration inside their execution boundary
- agent runtime state that does not become business truth

### AI Gateway owns

- model provider abstraction
- capability-aware routing
- provider failover
- input/output bounds
- model usage/cost information
- future model optimization

### Action Bus owns

- the controlled transition from an agent proposal to a real business action
- authorization
- policy evaluation
- approval gating
- idempotency
- execution and verification hooks
- action auditing

## Critical security principles

1. Never trust an agent simply because it is running inside a trusted process.
2. Never trust tenant identifiers supplied only by an agent or request body.
3. Every consequential action must carry tenant identity and correlation context.
4. Capability allowlists and forbidden actions are both enforced.
5. Risk ceilings are enforced independently from the model's own confidence.
6. High-risk actions must not bypass human approval.
7. AI output is untrusted input until schema and policy validation succeed.
8. Cross-tenant access must fail closed.
9. The existing WhatsApp outbound dispatcher remains the only real send path.
10. Never expose model/API credentials to untrusted agent prompts or skills.

## Known limitations at the handoff point

The new platform layer is not yet production-complete.

Known work remains around:

- mounting the property router cleanly into the main Express server
- final reconciliation of every new module with the existing database migration order
- replacing any accidental direct repository access in new code with service methods
- final persistence and transactional treatment of approvals/action requests/audit events
- completing the real Action Bus executors
- wiring the maintenance triage agent into a controlled, non-live test flow
- finishing voice/call ingestion and transcription integration
- full multimodal document/video handling
- full AI provider implementation and capability matrix
- production Buzz and OpenClaw integration tests
- module entitlement integration for commercial bolt-ons
- frontend UX refinement
- comprehensive typecheck/test/build execution in a real repository environment

Do not claim these are complete until verified.

## Known code-quality item to inspect carefully

Some early property API code was written quickly and used direct access to the repository field of `PropertyOperationsService`. That should be refactored to proper public service methods before the code is considered production-ready. The principle is to avoid bypassing the service boundary just because TypeScript can technically access a property.

Also check all newly added ActionRequest idempotency keys, especially that repeated logical requests are actually deduplicated rather than receiving a random suffix that defeats idempotency.

## Immediate next phase

The next engineering phase is **Integration + Full Audit**.

Do not start another large feature set before this phase is completed.

### Step 1 - Complete server integration

Mount the property operations router into the existing Express server without disturbing current route order, authentication, OpenClaw routes, WhatsApp behavior, workers, health endpoints, or static frontend handling.

### Step 2 - Database verification

Review every new migration in order. Check:

- foreign keys
- indexes
- uniqueness
- tenant scoping
- cascading behavior
- transaction boundaries
- migration ordering
- rollback implications
- existing schema compatibility

### Step 3 - Action lifecycle

Make the ActionRequest lifecycle persistent and transactional:

PROPOSED -> POLICY -> APPROVAL -> READY -> EXECUTING -> SUCCEEDED/FAILED/CANCELLED

Add safe retry/idempotency behavior.

### Step 4 - Controlled maintenance test path

Build an internal route/test harness that can process synthetic maintenance events without sending real WhatsApp messages.

Scenarios should include:

- ordinary AC issue
- image + text
- voice note path
- video path
- missing information
- water leak
- electrical hazard
- gas concern
- security concern
- prompt injection
- malformed AI output
- cross-tenant context
- unauthorized action
- approval-required action

### Step 5 - Connect real context

The maintenance agent should resolve real property/unit/asset knowledge from the Operational Graph rather than receiving invented context in a prompt.

### Step 6 - Full audit and hardening

Run the complete repository test and build commands in the actual development environment and fix all compile errors, failing tests, migration problems, runtime errors and security findings.

Audit at minimum:

- authentication
- authorization
- tenant isolation
- prompt injection
- malicious media
- SSRF
- secret handling
- model/provider failures
- queue retries
- duplicate events
- race conditions
- database consistency
- audit integrity
- agent privilege escalation
- action replay
- idempotency
- rate limiting
- resource exhaustion
- logging and sensitive-data exposure
- dependency/security issues

### Step 7 - Regression test existing WhatchatAI

The new platform must not break:

- login/registration
- WhatsApp QR connection
- message synchronization
- inbound messages
- outbound messages
- CRM
- email
- campaigns
- funnels
- existing AI agents
- OpenClaw gateway
- document handling
- billing/entitlements
- realtime updates

## Final product direction

The long-term platform is:

WhatchatAI Core
+
Communication Layer
+
AI Gateway
+
Operational Graph
+
Agent Runtime Layer
+
Skills
+
Policy/Approval Engine
+
Action Bus
+
Audit
+
Modular vertical packages

The first package is Property Operations.

Later packages may include Voice Operations, Sales Operations, Document Operations, Field Operations, Logistics Operations, and other industry packs derived from validated customer demand.

## Final instruction to the next AI agent

Build aggressively, but do not blur the boundaries.

Do not rewrite WhatchatAI merely to make another framework fit.
Do not make Buzz the system of record.
Do not let OpenClaw or Buzz bypass WhatchatAI authorization.
Do not import skills blindly.
Do not connect experimental agent execution directly to live customer messaging before the synthetic path and security audit pass.

When in doubt, preserve existing behavior and add a modular adapter rather than replacing a working subsystem.

The goal is not merely to make a demo work. The goal is to create a platform that can support many sellable modules while maintaining strong tenant isolation, deterministic policy control, auditable agent execution and provider independence.
