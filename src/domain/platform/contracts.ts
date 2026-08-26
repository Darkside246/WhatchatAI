import { z } from 'zod';

export const CommunicationEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  channel: z.enum(['WHATSAPP', 'SMS', 'VOICE', 'EMAIL', 'WEB']),
  conversationId: z.string(),
  sender: z.object({
    id: z.string().optional(),
    address: z.string(),
    displayName: z.string().optional(),
    role: z.enum(['GUEST', 'TENANT', 'STAFF', 'VENDOR', 'UNKNOWN']).default('UNKNOWN'),
  }),
  propertyId: z.string().optional(),
  message: z.object({
    type: z.enum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'CALL']),
    text: z.string().optional(),
    mediaUrl: z.string().url().optional(),
    mimeType: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  occurredAt: z.string().datetime(),
  correlationId: z.string(),
  idempotencyKey: z.string(),
});
export type CommunicationEvent = z.infer<typeof CommunicationEventSchema>;

export const OperationalEntitySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  type: z.enum(['CUSTOMER', 'PROPERTY', 'UNIT', 'ASSET', 'VENDOR', 'RESERVATION', 'WORK_ORDER', 'CONTACT']),
  name: z.string(),
  parentId: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});
export type OperationalEntity = z.infer<typeof OperationalEntitySchema>;

export const AgentCapabilitySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  description: z.string(),
  allowedActions: z.array(z.string()),
  forbiddenActions: z.array(z.string()),
  requiresApprovalFor: z.array(z.string()),
  maxRiskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentTaskSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  agentId: z.string(),
  capabilityId: z.string(),
  input: z.record(z.string(), z.unknown()),
  contextEntityIds: z.array(z.string()),
  correlationId: z.string(),
  createdAt: z.string().datetime(),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export const ActionRequestSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  requestedBy: z.object({ kind: z.enum(['AGENT', 'USER', 'SYSTEM']), id: z.string() }),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  approval: z.object({ required: z.boolean(), status: z.enum(['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED']) }),
  status: z.enum(['PENDING_POLICY', 'PENDING_APPROVAL', 'READY', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  correlationId: z.string(),
  createdAt: z.string().datetime(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  eventType: z.string(),
  actor: z.object({ kind: z.enum(['USER', 'AGENT', 'SYSTEM', 'VENDOR']), id: z.string() }),
  correlationId: z.string(),
  actionRequestId: z.string().optional(),
  payloadHash: z.string(),
  previousHash: z.string().optional(),
  occurredAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface AgentExecutionResult {
  status: 'completed' | 'failed';
  output: unknown;
  actionRequests: ActionRequest[];
  executionId: string;
}

export interface AgentRuntimeAdapter {
  readonly name: string;
  execute(task: AgentTask, context: unknown): Promise<AgentExecutionResult>;
  cancel(executionId: string, tenantId: string): Promise<void>;
  health(): Promise<{ healthy: boolean; details?: string }>;
}

export interface AIProviderMedia {
  mimeType: string;
  url?: string;
  base64Data?: string;
}

export interface AIProviderAdapter {
  readonly name: string;
  capabilities(): Promise<{ text: boolean; vision: boolean; audio: boolean; video: boolean; documents: boolean }>;
  generate(input: {
    tenantId: string;
    operation: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    media?: AIProviderMedia[];
    responseFormat?: 'text' | 'json';
    maxOutputTokens?: number;
  }): Promise<{ text: string; provider: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
}
