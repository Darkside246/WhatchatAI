# WhatchatAI Platform Contracts v1

Status: Proposed and implementation-ready

## Architectural invariant

**WhatchatAI owns reality; delegated runtimes execute agent work.**

WhatchatAI is authoritative for tenants, users, business data, communication records, operational entities, policies, approvals, actions, billing, and audit records.

Buzz is an execution subsystem behind an adapter boundary. Buzz must never become the customer-facing system of record, tenant authority, or policy authority.

## Contract lifecycle

```text
CommunicationEvent
  -> Context resolution
  -> AgentTask
  -> Agent result
  -> Policy evaluation
  -> ActionRequest
  -> Approval (when required)
  -> Action execution
  -> Verification
  -> AuditEvent
```

## 1. CommunicationEvent

Purpose: canonical representation of an externally observed communication. It records what actually arrived without allowing AI to rewrite source identity.

Required properties:

- `id`: internal UUID
- `tenantId`: authoritative business/tenant UUID
- `source.channel`: `whatsapp | voice | sms | email | web | system`
- `source.externalId`: immutable provider/source identifier
- `source.receivedAt`: ISO timestamp
- `actor.type`: `customer | guest | tenant | employee | contractor | unknown`
- `actor.externalIdentity`: provider identity exactly as received where applicable
- `conversationId`: optional internal conversation reference
- `content.type`: `text | image | video | audio | voice_note | document | call | event`
- `content.text`: optional extracted text, clearly marked as derived when not source-authored
- `content.mediaRef`: optional internal object-storage reference
- `content.mimeType`: optional MIME type
- `source.metadata`: provider metadata with strict allow-listing
- `lifecycle.isLive`: whether the event came from a live transport event
- `lifecycle.isHistorical`: whether the event was imported/synchronised

Invariants:

1. Provider identifiers are preserved exactly.
2. Historical events can never be routed into the live response path solely because they exist in history.
3. Tenant identity is established before business actions are permitted.
4. AI-derived text must never overwrite source content.
5. Media must retain provenance: source message ID, MIME type, storage identity.

## 2. OperationalEntity

Purpose: typed nodes and relationships representing business reality.

Base shape:

```ts
interface OperationalEntity {
  id: string;
  tenantId: string;
  type: string;
  version: number;
  status: 'active' | 'inactive' | 'archived';
  attributes: Record<string, unknown>;
  sourceRefs: Array<{
    system: string;
    externalId: string;
  }>;
  createdAt: string;
  updatedAt: string;
}
```

Initial property-domain entities:

- `business`
- `property`
- `unit`
- `room`
- `guest`
- `booking`
- `asset`
- `maintenance_incident`
- `work_order`
- `contractor`
- `procedure`
- `document`
- `contact`

Relationships are explicit, tenant-scoped, and versioned. Do not encode business relationships only inside free-form agent memory.

## 3. Agent

Agent definition is configuration plus capabilities, not unrestricted authority.

```ts
interface AgentDefinition {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: 'draft' | 'active' | 'paused' | 'retired';
  purpose: string;
  capabilities: string[];
  toolIds: string[];
  allowedEntityTypes: string[];
  policyProfileId: string;
  escalationPolicyId: string;
}
```

Agents are always tenant-scoped.

## 4. AgentCapability

Capabilities define what an agent may request, not what it can unilaterally accomplish.

Example:

```json
{
  "id": "incident.create",
  "resource": "maintenance_incident",
  "operation": "create",
  "risk": "low",
  "requiresApproval": false
}
```

High-risk capabilities must require policy enforcement and, where configured, human approval.

## 5. AgentTask

Purpose: represent an AI reasoning/extraction/classification task separately from any external action.

```ts
interface AgentTask {
  id: string;
  tenantId: string;
  agentId: string;
  taskType: string;
  inputRefs: string[];
  contextRefs: string[];
  requestedAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  resultRef?: string;
  modelRunRef?: string;
}
```

Examples:

- classify maintenance intent
- summarise call
- extract booking details
- analyse image for observable conditions
- determine whether escalation criteria are met

An `AgentTask` does not itself execute customer-visible or physical actions.

## 6. ActionRequest

Purpose: a normalized request to change something outside the reasoning boundary.

```ts
interface ActionRequest {
  id: string;
  tenantId: string;
  requestedBy: {
    actorType: 'agent' | 'user' | 'system';
    actorId: string;
  };
  actionType: string;
  target: {
    entityType: string;
    entityId: string;
  };
  parameters: Record<string, unknown>;
  policyProfileId: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  approvalRequirement: 'none' | 'optional' | 'required';
  status:
    | 'proposed'
    | 'policy_rejected'
    | 'awaiting_approval'
    | 'approved'
    | 'executing'
    | 'executed'
    | 'failed'
    | 'cancelled';
  idempotencyKey: string;
  createdAt: string;
}
```

The same action contract must support software actions now and physical/IoT actuators later without changing the policy model.

## 7. Approval

```ts
interface Approval {
  id: string;
  tenantId: string;
  actionRequestId: string;
  approverType: 'user' | 'role';
  approverId?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  reason?: string;
  createdAt: string;
  decidedAt?: string;
}
```

Approvals must be explicit records. Never encode an approval solely in an agent prompt or chat message.

## 8. Tool

A tool is a controlled capability exposed to an agent runtime.

```ts
interface ToolDefinition {
  id: string;
  tenantScope: 'platform' | 'tenant';
  name: string;
  version: string;
  inputSchema: object;
  outputSchema: object;
  sideEffectClass: 'read' | 'write' | 'external_action';
  requiredCapabilities: string[];
  timeoutMs: number;
}
```

The runtime may request tools, but WhatchatAI authorizes the invocation.

## 9. AuditEvent

Purpose: tamper-evident operational history.

```ts
interface AuditEvent {
  id: string;
  tenantId: string;
  sequence: number;
  eventType: string;
  actor: {
    type: 'user' | 'agent' | 'system' | 'external';
    id: string;
  };
  correlationId: string;
  causationId?: string;
  payloadDigest: string;
  payload: Record<string, unknown>;
  previousDigest?: string;
  occurredAt: string;
}
```

The audit ledger is tamper-evident, not described as absolutely immutable unless the final storage design provides that property.

Sensitive raw customer content should not be duplicated into audit records unnecessarily. Store references and cryptographic digests where possible.

## 10. AI provider contract

WhatchatAI must not directly depend on one model vendor.

```ts
interface AIProvider {
  id: string;
  capabilities(): Promise<AICapabilities>;
  generate(request: AIRequest): Promise<AIResponse>;
  analyseImage?(request: ImageRequest): Promise<AIResponse>;
  transcribeAudio?(request: AudioRequest): Promise<TranscriptResponse>;
}
```

Provider implementations may include:

- Gemini
- OpenAI
- Anthropic
- Azure/Microsoft Foundry
- OpenAI-compatible endpoints
- local inference in future

Provider selection belongs to the WhatchatAI intelligence layer, not to domain modules.

## 11. Buzz adapter contract

Buzz is accessed through an adapter rather than imported throughout the application.

```ts
interface AgentExecutionRuntime {
  createSession(input: CreateSessionInput): Promise<RuntimeSession>;
  runTask(input: RunAgentTaskInput): Promise<AgentTaskResult>;
  cancelTask(taskId: string): Promise<void>;
  health(): Promise<RuntimeHealth>;
}
```

Initial implementation:

`BuzzAgentRuntimeAdapter`

The adapter is responsible for translating our `AgentTask`, tool definitions, context references and allowed capabilities into Buzz-compatible execution requests.

Buzz never receives unrestricted tenant database access.

## 12. Policy boundary

Authorization and policy enforcement belong to WhatchatAI.

Execution flow:

```text
agent request
  -> tenant authorization
  -> capability check
  -> policy evaluation
  -> approval check
  -> action execution
  -> verification
  -> audit
```

A Buzz tool call is not sufficient evidence that an action is authorized.

## 13. Idempotency

Every externally visible action must have an idempotency key.

Examples:

- outbound message
- contractor dispatch
- booking mutation
- webhook delivery
- payment-related request

Duplicate requests must resolve to the same logical action rather than causing duplicate side effects.

## 14. Tenant isolation

Every contract carries `tenantId` or is derived from a trusted tenant context.

Cross-tenant references must fail closed.

Agents must never choose their own tenant.

Operational graph queries, memory/context retrieval, tools, action requests and audit events must all respect tenant isolation.

## 15. Property Operations example

```text
Guest WhatsApp message
  -> CommunicationEvent
  -> identify guest/property
  -> create AgentTask: maintenance-intent
  -> Buzz executes reasoning
  -> result: likely AC leak, high concern
  -> Whatchat policy evaluates
  -> ActionRequest: escalate_to_pm
  -> no external contractor dispatch yet
  -> PM approves contractor dispatch
  -> ActionRequest: dispatch_contractor
  -> action executes
  -> result verified
  -> AuditEvent chain updated
```

## 16. Versioning rules

All externally consumed contracts must be versioned.

Breaking changes require a new major contract version or an explicit migration path.

Prefer additive changes.

Persist the contract version on durable records where practical.

## 17. Implementation rule

Do not implement the entire long-term platform in one change.

Phase implementation:

1. Contract types + validation
2. CommunicationEvent adapter around existing WhatsApp ingestion
3. AgentTask and provider gateway
4. Buzz adapter in read-only/safe execution mode
5. ActionRequest + approval engine
6. Audit event chain
7. Property Operational Graph
8. Property maintenance module

## 18. Non-goals

These contracts do not require:

- training our own foundation model
- replacing PostgreSQL with Buzz's event store
- replacing WhatchatAI authentication
- importing Buzz's desktop client
- importing Buzz's entire relay UI
- creating a generic 150-agent marketplace before the runtime is proven

## 19. Definition of done for v1 contracts

- Contracts compile with strict TypeScript
- Zod schemas validate external input
- Tenant boundaries are tested
- Historical events cannot invoke live AI
- Agent tasks and actions have separate identifiers
- Action requests are idempotent
- Approval is explicit
- Audit events are correlated
- AI provider is injectable
- Buzz execution is behind one adapter
