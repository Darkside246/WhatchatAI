import { z } from 'zod';

export const communicationChannelSchema = z.enum(['whatsapp', 'voice', 'sms', 'email', 'web', 'system']);
export type CommunicationChannel = z.infer<typeof communicationChannelSchema>;

export const actorTypeSchema = z.enum(['customer', 'guest', 'tenant', 'employee', 'contractor', 'unknown']);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const communicationContentTypeSchema = z.enum([
  'text',
  'image',
  'video',
  'audio',
  'voice_note',
  'document',
  'call',
  'event',
]);
export type CommunicationContentType = z.infer<typeof communicationContentTypeSchema>;

export const communicationEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  source: z.object({
    channel: communicationChannelSchema,
    externalId: z.string().min(1),
    receivedAt: z.string().datetime({ offset: true }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  actor: z.object({
    type: actorTypeSchema,
    externalIdentity: z.string().min(1),
  }),
  conversationId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  content: z.object({
    type: communicationContentTypeSchema,
    text: z.string().optional(),
    mediaRef: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
  }),
  lifecycle: z.object({
    isLive: z.boolean(),
    isHistorical: z.boolean(),
  }).refine((value) => !(value.isLive && value.isHistorical), {
    message: 'A communication event cannot be both live and historical',
  }),
});
export type CommunicationEvent = z.infer<typeof communicationEventSchema>;

export const agentStatusSchema = z.enum(['draft', 'active', 'paused', 'retired']);
export const agentDefinitionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(200),
  version: z.number().int().positive(),
  status: agentStatusSchema,
  purpose: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  toolIds: z.array(z.string().min(1)),
  allowedEntityTypes: z.array(z.string().min(1)),
  policyProfileId: z.string().min(1),
  escalationPolicyId: z.string().min(1),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const agentTaskStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const agentTaskSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  taskType: z.string().min(1),
  inputRefs: z.array(z.string().min(1)),
  contextRefs: z.array(z.string().min(1)),
  requestedAt: z.string().datetime({ offset: true }),
  status: agentTaskStatusSchema,
  resultRef: z.string().min(1).optional(),
  modelRunRef: z.string().min(1).optional(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

export const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export const actionApprovalRequirementSchema = z.enum(['none', 'optional', 'required']);
export const actionStatusSchema = z.enum([
  'proposed',
  'policy_rejected',
  'awaiting_approval',
  'approved',
  'executing',
  'executed',
  'failed',
  'cancelled',
]);
export const actionRequestSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  requestedBy: z.object({
    actorType: z.enum(['agent', 'user', 'system']),
    actorId: z.string().min(1),
  }),
  actionType: z.string().min(1),
  target: z.object({
    entityType: z.string().min(1),
    entityId: z.string().min(1),
  }),
  parameters: z.record(z.string(), z.unknown()),
  policyProfileId: z.string().min(1),
  riskLevel: riskLevelSchema,
  approvalRequirement: actionApprovalRequirementSchema,
  status: actionStatusSchema,
  idempotencyKey: z.string().min(1).max(512),
  createdAt: z.string().datetime({ offset: true }),
});
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export const approvalSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  actionRequestId: z.string().uuid(),
  approverType: z.enum(['user', 'role']),
  approverId: z.string().min(1).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
  reason: z.string().max(4000).optional(),
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  sequence: z.number().int().positive(),
  eventType: z.string().min(1),
  actor: z.object({
    type: z.enum(['user', 'agent', 'system', 'external']),
    id: z.string().min(1),
  }),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  payload: z.record(z.string(), z.unknown()),
  previousDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  occurredAt: z.string().datetime({ offset: true }),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const toolDefinitionSchema = z.object({
  id: z.string().min(1),
  tenantScope: z.enum(['platform', 'tenant']),
  name: z.string().min(1),
  version: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  sideEffectClass: z.enum(['read', 'write', 'external_action']),
  requiredCapabilities: z.array(z.string().min(1)),
  timeoutMs: z.number().int().positive().max(900_000),
});
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const aiRequestSchema = z.object({
  operation: z.string().min(1),
  tenantId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  input: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AIRequest = z.infer<typeof aiRequestSchema>;

export const aiResponseSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  output: z.unknown(),
  latencyMs: z.number().nonnegative(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }).optional(),
  finishReason: z.string().optional(),
});
export type AIResponse = z.infer<typeof aiResponseSchema>;

export interface AgentExecutionRuntime {
  createSession(input: {
    tenantId: string;
    agentId: string;
    taskId: string;
    capabilities: string[];
    toolIds: string[];
  }): Promise<{ sessionId: string }>;

  runTask(input: {
    sessionId: string;
    task: AgentTask;
    context: unknown;
  }): Promise<{
    status: 'completed' | 'failed';
    output: unknown;
    actionRequests: ActionRequest[];
  }>;

  cancelTask(taskId: string): Promise<void>;
  health(): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; detail?: string }>;
}
