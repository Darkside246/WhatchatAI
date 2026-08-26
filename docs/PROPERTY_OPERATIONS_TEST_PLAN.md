# Property Operations Release Test Plan

This plan is the quality gate for the Property Operations OS work. The live WhatsApp responder remains unchanged until the integration gates are passed.

## Phase A: Platform contracts

Verify that CommunicationEvent, AgentTask, ActionRequest, Approval and AuditEvent preserve tenant identity and correlation identifiers.

Reject malformed media references, missing tenant IDs, invalid risk levels, unregistered actions and agent identity mismatches.

## Phase B: AI gateway

Verify provider registration, priority selection, preferred-provider selection, capability matching, fallback, timeout behaviour and fail-closed behaviour.

A request requiring vision must never be routed to a text-only provider.

A provider failure must not cause a request to silently cross a tenant boundary or lose its correlation identifier.

## Phase C: Agent execution

Run at least one synthetic task through the Buzz adapter.

Verify execution timeout, process termination, stderr draining, bounded input, bounded output and rejection of malformed agent results.

No agent runtime receives PostgreSQL, Redis, WhatsApp session or encryption credentials.

## Phase D: Operational Graph

Verify every read and write is scoped by business ID.

Attempt cross-business property, unit, asset, vendor, incident and knowledge lookups and confirm that they fail closed.

Verify parent-child constraints prevent orphaned graph nodes and invalid relationships.

## Phase E: Action and approval

Verify low-risk allowed actions can become READY.

Verify high-risk actions become PENDING_APPROVAL.

Verify forbidden and above-ceiling actions are DENIED.

Verify approved actions can resume and rejected actions cannot execute.

Verify action idempotency survives process restarts through PostgreSQL rather than process memory.

## Phase F: Multimodal maintenance triage

Test text, image, audio/voice note, document metadata and video-gated requests.

Life-safety signals must be evaluated before model output.

Invalid model JSON must fail safe and request human review.

Prompt-injection content in guest text, media descriptions or knowledge must not override system policy.

## Phase G: Property workflow

Test:

Guest message -> property resolution -> context retrieval -> triage -> incident -> work-order draft -> approval -> action -> audit.

Measure latency, human intervention rate, false emergency rate, missed escalation rate and AI cost per successful resolution.

## Phase H: Production readiness

Run npm run typecheck and npm test in CI.

Run dependency and secret scanning.

Verify migrations from a clean database and an existing database.

Verify backup/restore procedures.

Verify Redis and PostgreSQL failure recovery.

Verify duplicate webhook delivery and job retry behaviour.

Verify the existing WhatsApp QR/session path is unchanged.

## Release blockers

Do not enable live property automation if any of these are true:

- Cross-tenant data is readable or writable.
- An agent can bypass an ActionRequest policy.
- A human-approval action can execute without approval.
- Audit-chain verification fails.
- Safety rules can be downgraded by model output.
- Duplicate requests can produce duplicate external actions.
- AI output is trusted without schema validation.
- Buzz/OpenClaw receives direct business-database write authority.
- Existing WhatsApp connection/reconnection behaviour regresses.
