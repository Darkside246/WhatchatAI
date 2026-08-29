export type AiToolRisk = 'READ' | 'WRITE' | 'SEND' | 'HIGH_RISK' | 'SYSTEM';

export interface AiToolPolicyEntry {
  name: string;
  risk: AiToolRisk;
  description: string;
}

/**
 * Every AI-invocable tool must be registered here with an explicit risk
 * tier before it can be wired into any Gemini/Goose call - this is the
 * production-safety directive's "zero-trust AI tool model" (Section 7)
 * made real rather than aspirational. Adding a new tool anywhere without
 * also registering it here means `agentGuard` rejects it - fails closed,
 * not open.
 */
const AI_TOOL_POLICY: Record<string, AiToolPolicyEntry> = {
  get_current_time: {
    name: 'get_current_time',
    risk: 'READ',
    description:
      'Reads the trusted, server-computed TimeContext for the business. Takes no arguments; no corresponding write/set tool exists anywhere in this codebase.',
  },
  update_conversation_memory: {
    name: 'update_conversation_memory',
    risk: 'WRITE',
    description:
      'Writes a goal/facts/open-questions patch to this exact conversation\'s structured state row (conversation_states). ' +
      'Cannot touch any other business record, execute any action, or affect any other conversation.',
  },
};

export function getToolPolicy(toolName: string): AiToolPolicyEntry | null {
  return AI_TOOL_POLICY[toolName] ?? null;
}

/** Fail-closed: an unregistered tool name is never implicitly trusted, regardless of what a model response or caller claims about it. */
export function isToolRegistered(toolName: string): boolean {
  return toolName in AI_TOOL_POLICY;
}

export function listRegisteredTools(): AiToolPolicyEntry[] {
  return Object.values(AI_TOOL_POLICY);
}

/**
 * SYSTEM-tier tools are never reachable through the production AI
 * conversation path, full stop - this is the directive's own explicit
 * rule ("no AI agent given SYSTEM permissions in the production
 * conversation path"), enforced here rather than left as a convention
 * every future tool addition has to remember. Registering a tool as
 * SYSTEM-tier documents its risk; it does not grant it a path to
 * execution from a customer-facing agent.
 */
export function isTierAlwaysDenied(risk: AiToolRisk): boolean {
  return risk === 'SYSTEM';
}
