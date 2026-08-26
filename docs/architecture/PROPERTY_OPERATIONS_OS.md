# WhatchatAI Property Operations OS

## Architecture rule

**WhatchatAI owns reality. Agent runtimes execute delegated work.**

WhatchatAI remains authoritative for tenant identity, communication events, operational entities, policy, approvals, actions, billing and audit history. Buzz and OpenClaw are runtime implementations behind adapters. Neither runtime becomes the system of record.

## Planes

1. Product / Control Plane - tenants, users, RBAC, billing and configuration.
2. Communication Plane - WhatsApp and future channels; canonical `CommunicationEvent`.
3. Event / Workflow Plane - Redis/BullMQ, idempotency and deterministic state transitions.
4. Operational Graph - property, unit, asset, reservation, vendor and work-order context.
5. Intelligence Plane - provider-neutral AI gateway and multimodal model routing.
6. Agent Execution Plane - Buzz/OpenClaw adapters, sandboxing and capability enforcement.
7. Action / Actuation Plane - policy-checked actions, approvals, human dispatch and future device integrations.

## First commercial workflow

Guest -> WhatsApp -> CommunicationEvent -> property/asset context -> multimodal triage -> deterministic safety policy -> ActionRequest -> human/vendor handoff -> AuditEvent.

Supported intake types are text, image, audio/voice note, document, video and calls. Video processing may be feature-flagged or size/duration limited during the MVP to protect cost and latency.

## Runtime boundary

The runtime receives only the minimum context required for its delegated task. It must not receive unrestricted database credentials. Tool calls are capability-bound and all consequential actions return through the Action Bus and policy layer.

## AI provider boundary

Business logic must not call a model vendor directly. All model inference goes through an `AiProviderAdapter`/AI Gateway so providers can be changed, combined or disabled without rewriting property workflows.

## Security requirements

- Every event and action is tenant-bound.
- Cross-tenant context leakage is a release-blocking defect.
- Agent output is untrusted input until validated.
- Life/safety classifications default toward escalation when confidence or evidence is insufficient.
- Financial, lease, booking and consequential vendor actions require explicit policy/approval rules.
- Audit records are append-only and tamper-evident.
- Media is treated as untrusted content and must never be allowed to alter agent permissions.

## Commercialisation

Vertical modules are plugins/configurations over the platform primitives. Property Operations is the first module. Future modules can reuse the same communication, graph, AI, agent, action and audit infrastructure without creating separate platforms.
