import { routeInboundMessage, resolveEscalationAgent } from '../agentRoutingService.js';
import { gatherAiHandoffContext } from '../aiContextGathererService.js';
import { generateAiReply } from '../aiReplyService.js';
import type { AiAgentRecord } from '../../repositories/aiAgentRepository.js';

export interface OrchestrateAiReplyInput {
  businessId: string;
  chatId: string;
  contactId: string | null;
  queryText: string;
}

export type OrchestratedAiOutcome =
  | { kind: 'no_agent'; reason: string }
  | { kind: 'escalate_to_human'; reason: string; matchedKeyword: string }
  | { kind: 'reply'; agent: AiAgentRecord; text: string }
  | { kind: 'unavailable'; agent: AiAgentRecord; reason: string };

/**
 * The single entry point that centralizes "which agent, given what
 * context, says what" - replacing what used to be three services
 * (routeInboundMessage, gatherAiHandoffContext, generateAiReply) called
 * separately and stitched together inline in the incoming-messages queue
 * worker. Every side effect that follows a decision - notifications,
 * ai_mode transitions, the actual outbound send - stays in the caller,
 * since those are queue/dispatch concerns, not AI orchestration ones:
 * this function's job ends at "here is what the AI decided," never "and
 * here is what happened to the chat as a result." Preserves the exact
 * same routing/escalation/context logic that existed before this phase -
 * a consolidation, not a rewrite.
 */
export async function orchestrateAiReply(input: OrchestrateAiReplyInput): Promise<OrchestratedAiOutcome> {
  const [context, decision] = await Promise.all([
    gatherAiHandoffContext({
      businessId: input.businessId,
      chatId: input.chatId,
      contactId: input.contactId,
      queryText: input.queryText,
    }),
    routeInboundMessage(input.businessId, input.queryText),
  ]);

  if (decision.outcome === 'no_agent') {
    return { kind: 'no_agent', reason: decision.reason };
  }
  if (decision.outcome === 'escalate_to_human') {
    return { kind: 'escalate_to_human', reason: decision.reason, matchedKeyword: decision.matchedKeyword };
  }

  const agent = decision.agent;
  let reply = await generateAiReply(agent, context);

  // A real escalation hop: if the selected agent could not produce a
  // reply and the operator configured someone to escalate to, try that
  // agent once. Exactly one hop - never a chain that could loop between
  // two agents pointing at each other.
  if (reply.status !== 'generated') {
    const escalationAgent = await resolveEscalationAgent(agent);
    if (escalationAgent) {
      reply = await generateAiReply(escalationAgent, context);
      if (reply.status === 'generated') {
        return { kind: 'reply', agent: escalationAgent, text: reply.text };
      }
      return { kind: 'unavailable', agent: escalationAgent, reason: reply.reason };
    }
    return { kind: 'unavailable', agent, reason: reply.reason };
  }

  return { kind: 'reply', agent, text: reply.text };
}
