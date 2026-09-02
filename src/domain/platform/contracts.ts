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
  idempotencyKey: z.string().min(1).max(512),
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
  maxRiskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
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
  idempotencyKey: z.string().min(1).max(512),
  correlationId: z.string(),
  createdAt: z.string().datetime(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const AuditActorSchema = z.object({ kind: z.enum(['USER', 'AGENT', 'SYSTEM', 'VENDOR', 'EXTERNAL']), id: z.string() });

export const AuditEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  eventType: z.string(),
  actor: AuditActorSchema,
  correlationId: z.string(),
  actionRequestId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
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

/**
 * A JSON-schema-shaped function/tool declaration, provider-agnostic. The
 * gateway never interprets `parameters` itself - each provider adapter
 * translates it into whatever native shape its own SDK expects (Gemini's
 * `Type` enum values, a plain OpenAI-style JSON schema, etc). Named to match
 * the vocabulary every provider's own function-calling API already uses
 * (name/description/parameters), not an AURA-specific shape.
 */
export interface AIProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIProviderToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AIProviderToolResponse {
  name: string;
  response: Record<string, unknown>;
}

/**
 * Thrown by a provider's generate() to signal "this specific request shape
 * (an optional-parameter combination) was rejected, but a stripped-down
 * request would likely succeed" - as opposed to a generic failure (bad
 * credentials, network error, capacity), which should just fail over to the
 * next provider as usual. Grounded in a real production incident: at least
 * one deployed Gemini model/key rejects the temperature+thinkingConfig
 * combination outright with a bare 400, no field-level detail. A provider
 * throws this instead of a plain Error only when it can actually identify
 * that class of rejection (e.g. an HTTP 400 from its own SDK) - never as a
 * generic "something went wrong" catch-all.
 */
export class ProviderConfigRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigRejectedError';
  }
}

export interface AIProviderAdapter {
  readonly name: string;
  capabilities(): Promise<{ text: boolean; vision: boolean; audio: boolean; video: boolean; documents: boolean; functionCalling: boolean }>;
  generate(input: {
    tenantId: string;
    operation: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    media?: AIProviderMedia[];
    responseFormat?: 'text' | 'json';
    maxOutputTokens?: number;
    temperature?: number;
    tools?: AIProviderToolDefinition[];
    /** Present only on a follow-up call answering a tool call the model just made - the exact call(s) being answered. */
    pendingToolCalls?: AIProviderToolCall[];
    toolResponses?: AIProviderToolResponse[];
  }): Promise<{
    text: string;
    provider: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    /** Present instead of (or alongside a possibly-empty) text when the model wants to call a tool. */
    toolCalls?: AIProviderToolCall[];
  }>;
  /**
   * Optional same-provider fallback: the most minimal request this provider
   * can make - no media, no tools, no temperature, no responseFormat
   * override. Called by AiGateway at most once, on the same provider,
   * strictly after generate() threw ProviderConfigRejectedError - never as
   * a normal code path, and never by a caller directly. A provider that
   * doesn't implement this simply has no reduced fallback: AiGateway treats
   * the ProviderConfigRejectedError like any other failure and moves on to
   * the next provider in the chain.
   */
  generateReduced?(input: {
    tenantId: string;
    operation: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    maxOutputTokens?: number;
  }): Promise<{
    text: string;
    provider: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
}
