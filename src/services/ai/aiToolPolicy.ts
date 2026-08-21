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
 * made real rather than aspirational. Today there is exactly one tool,
 * and it is READ-only, deliberately: no WRITE/SEND/HIGH_RISK/SYSTEM-tier
 * tool has ever been given to the model in this codebase. Adding a new
 * tool anywhere without also registering it here means `agentGuard`
 * rejects it - fails closed, not open.
 */
const AI_TOOL_POLICY: Record<string, AiToolPolicyEntry> = {
  get_current_time: {
    name: 'get_current_time',
    risk: 'READ',
    description:
      'Reads the trusted, server-computed TimeContext for the business. Takes no arguments; no corresponding write/set tool exists anywhere in this codebase.',
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
