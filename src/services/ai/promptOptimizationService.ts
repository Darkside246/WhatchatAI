import { pool } from '../../db/pool.js';
import {
  AiAgentPromptOptimizationRepository,
  type AiAgentPromptOptimizationRecord,
} from '../../repositories/aiAgentPromptOptimizationRepository.js';
import { AiAgentRepository } from '../../repositories/aiAgentRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';

const optimizationRepository = new AiAgentPromptOptimizationRepository(pool);
const agentRepository = new AiAgentRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class AgentNotFoundError extends Error {}
export class PromptOptimizationNotFoundError extends Error {}
export class InvalidPromptOptimizationError extends Error {}
export class PromptOptimizationAlreadyDecidedError extends Error {}

const MAX_INSTRUCTION_LENGTH = 8_000;

async function requireOwnedAgent(businessId: string, agentId: string) {
  const agent = await agentRepository.findByIdForBusiness(agentId, businessId);
  if (!agent || agent.deletedAt) {
    throw new AgentNotFoundError('AI agent not found.');
  }
  return agent;
}

export interface ImportPromptOptimizationInput {
  optimizedInstruction: string;
  metricName?: string | null | undefined;
  metricScore?: number | null | undefined;
  datasetSummary?: Record<string, unknown> | undefined;
}

/**
 * The one, controlled entry point for an offline DSPy run's result to reach
 * this application - see services/prompt-optimizer/ (a separate Python
 * process, run manually by an operator, never given live database
 * credentials and never called at request time). Imports a row as
 * 'pending_review' only; nothing here ever changes what a live agent
 * actually says - see approveOptimization for the one action that does.
 * Untrusted input (the optimized text itself came out of an offline
 * pipeline over data this process never validated), so it's bounded and
 * audited the same as any other externally-sourced content entering the
 * system.
 */
export async function importPromptOptimization(
  businessId: string,
  agentId: string,
  input: ImportPromptOptimizationInput,
): Promise<AiAgentPromptOptimizationRecord> {
  const agent = await requireOwnedAgent(businessId, agentId);

  const optimizedInstruction = input.optimizedInstruction.trim();
  if (!optimizedInstruction) {
    throw new InvalidPromptOptimizationError('Optimized instruction is required.');
  }
  if (optimizedInstruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new InvalidPromptOptimizationError(`Optimized instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters.`);
  }

  const record = await optimizationRepository.create({
    businessId,
    agentId,
    baselineInstruction: agent.systemInstruction,
    optimizedInstruction,
    metricName: input.metricName ?? null,
    metricScore: input.metricScore ?? null,
    datasetSummary: input.datasetSummary ?? {},
  });

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'ai_prompt_optimization_imported',
    reason: `A DSPy prompt optimization was imported for review (agent "${agent.name}")`,
    rawMetadata: { agentId, optimizationId: record.id, metricName: record.metricName, metricScore: record.metricScore },
  });

  return record;
}

export async function listPromptOptimizations(businessId: string, agentId: string): Promise<AiAgentPromptOptimizationRecord[]> {
  await requireOwnedAgent(businessId, agentId);
  return optimizationRepository.listByAgent(businessId, agentId);
}

async function requirePendingOptimization(businessId: string, agentId: string, optimizationId: string) {
  const optimization = await optimizationRepository.findByIdForAgent(businessId, agentId, optimizationId);
  if (!optimization) throw new PromptOptimizationNotFoundError('Prompt optimization not found.');
  if (optimization.status !== 'pending_review') {
    throw new PromptOptimizationAlreadyDecidedError(`This optimization was already ${optimization.status}.`);
  }
  return optimization;
}

/**
 * The only path by which a DSPy-proposed instruction ever reaches a live
 * agent - a real, authenticated operator decision (gated by the `ai.edit`
 * permission at the API layer, same as any other manual agent edit), never
 * automatic. Applies through the exact same AiAgentRepository.update() a
 * manual Settings edit uses, preserving every other field on the agent
 * untouched, and writes the same `agent_updated` event a manual edit would -
 * this is not a separate, lesser-audited code path for changing what an
 * agent says.
 */
export async function approveOptimization(
  businessId: string,
  agentId: string,
  optimizationId: string,
  reviewedBy: string,
): Promise<AiAgentPromptOptimizationRecord> {
  const agent = await requireOwnedAgent(businessId, agentId);
  await requirePendingOptimization(businessId, agentId, optimizationId);

  const approved = await optimizationRepository.markApproved(optimizationId, reviewedBy);
  if (!approved) throw new PromptOptimizationAlreadyDecidedError('This optimization was already decided.');

  const updated = await agentRepository.update(agentId, { ...agent, systemInstruction: approved.optimizedInstruction });
  if (!updated) throw new AgentNotFoundError('AI agent not found.');

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'ai_prompt_optimization_approved',
    severity: 'warning',
    reason: `An operator approved a DSPy prompt optimization, replacing the live system instruction for agent "${agent.name}"`,
    rawMetadata: { agentId, optimizationId, reviewedBy },
  });

  return approved;
}

export async function rejectOptimization(
  businessId: string,
  agentId: string,
  optimizationId: string,
  reviewedBy: string,
  reason: string | null,
): Promise<AiAgentPromptOptimizationRecord> {
  await requireOwnedAgent(businessId, agentId);
  await requirePendingOptimization(businessId, agentId, optimizationId);

  const rejected = await optimizationRepository.markRejected(optimizationId, reviewedBy, reason);
  if (!rejected) throw new PromptOptimizationAlreadyDecidedError('This optimization was already decided.');

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'ai_prompt_optimization_rejected',
    reason: `An operator rejected a DSPy prompt optimization for agent ${agentId}`,
    rawMetadata: { agentId, optimizationId, reviewedBy },
  });

  return rejected;
}

export function isAgentNotFoundError(error: unknown): error is AgentNotFoundError {
  return error instanceof AgentNotFoundError;
}
export function isPromptOptimizationNotFoundError(error: unknown): error is PromptOptimizationNotFoundError {
  return error instanceof PromptOptimizationNotFoundError;
}
export function isInvalidPromptOptimizationError(error: unknown): error is InvalidPromptOptimizationError {
  return error instanceof InvalidPromptOptimizationError;
}
export function isPromptOptimizationAlreadyDecidedError(error: unknown): error is PromptOptimizationAlreadyDecidedError {
  return error instanceof PromptOptimizationAlreadyDecidedError;
}
