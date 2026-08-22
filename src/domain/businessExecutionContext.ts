import { randomUUID } from 'node:crypto';

/**
 * The one shape every business-scoped operation should eventually carry,
 * across every surface that reaches into this app on a business's behalf
 * (the web app, the AI reply pipeline, OpenClaw/MCP tool calls, and future
 * document/storage-connector work). Not retrofitted into existing services
 * in this pass - introduced now so new work (Knowledge Base 2.0, storage
 * connectors, AI document actions) builds against one consistent context
 * from day one instead of each area inventing its own ad hoc parameter
 * list.
 *
 * The defining property: nothing here is ever supplied by a model, a tool
 * call's own arguments, or unauthenticated request input. Every factory
 * below derives businessId/actorType/actorId from something the server
 * itself already authenticated (a session, a cell's bearer token) before
 * this context exists.
 */
export interface BusinessExecutionContext {
  readonly businessId: string;
  readonly actorType: 'user' | 'ai' | 'system';
  /** The authenticated user id (actorType 'user') or the OpenClaw cell id (actorType 'ai'). Absent for actorType 'system' (scheduled sweeps, workers with no single human/agent actor). */
  readonly actorId?: string;
  /** Unique per call, for correlating this operation across logs/audit rows - never reused, never client-supplied. */
  readonly requestId: string;
}

/** A human operator acting through the authenticated web app - businessId/userId both already resolved from the session, never from request input. */
export function businessExecutionContextForUser(businessId: string, userId: string): BusinessExecutionContext {
  return { businessId, actorType: 'user', actorId: userId, requestId: randomUUID() };
}

/** An AI agent acting through an authenticated OpenClaw cell - businessId/cellId both already resolved from the cell's own bearer-token lookup, never from the tool call's own arguments. */
export function businessExecutionContextForAiCell(businessId: string, cellId: string): BusinessExecutionContext {
  return { businessId, actorType: 'ai', requestId: randomUUID(), actorId: cellId };
}

/** A scheduled sweep or background job acting on a specific business with no single human/agent actor behind it. */
export function businessExecutionContextForSystem(businessId: string): BusinessExecutionContext {
  return { businessId, actorType: 'system', requestId: randomUUID() };
}
