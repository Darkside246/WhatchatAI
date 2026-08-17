import { getGeminiClient } from './geminiClient.js';
import type { AiAgentRecord } from '../repositories/aiAgentRepository.js';
import type { AiHandoffContext } from './aiContextGathererService.js';

export type AiReplyResult = { status: 'generated'; text: string } | { status: 'unavailable'; reason: string };

// A runaway generation should never be relayed to a real customer verbatim,
// regardless of what the model returns.
const MAX_REPLY_CHARS = 2000;

function buildSystemInstruction(agent: AiAgentRecord, context: AiHandoffContext): string {
  const lines: string[] = [
    `You are an AI assistant replying on behalf of a real business over WhatsApp${agent.name ? `, operating as "${agent.name}"` : ''}.`,
  ];

  if (agent.persona) lines.push(`Persona: ${agent.persona}`);
  if (agent.tone) lines.push(`Tone: ${agent.tone}`);
  if (agent.language) lines.push(`Reply in: ${agent.language}`);
  if (agent.businessContext) lines.push(`Business context: ${agent.businessContext}`);
  if (agent.responseStyle) lines.push(`Response style: ${agent.responseStyle}`);
  if (agent.systemInstruction) lines.push(agent.systemInstruction);

  if (context.crmContact) {
    const facts: string[] = [];
    if (context.crmContact.stage) facts.push(`stage=${context.crmContact.stage}`);
    if (context.crmContact.leadStatus) facts.push(`leadStatus=${context.crmContact.leadStatus}`);
    if (context.crmContact.notes) facts.push(`notes="${context.crmContact.notes}"`);
    if (facts.length > 0) lines.push(`Known CRM record for this customer: ${facts.join(', ')}.`);
  }

  if (context.knowledgeBase.available && context.knowledgeBase.results.length > 0) {
    const excerpts = context.knowledgeBase.results.map((result) => `- ${result.title}: ${result.snippet}`).join('\n');
    lines.push(`Relevant knowledge base excerpts:\n${excerpts}`);
  }

  lines.push(
    'Hard rules: reply only using the real information above and the conversation history below - never invent ' +
      'facts, prices, policies, order statuses, or promises you cannot verify from that information. If you do not ' +
      "have enough real information to answer, say so honestly and offer to have a human follow up, rather than " +
      'guessing. Keep the reply concise and WhatsApp-appropriate: short, plain text, no markdown headers or code ' +
      'blocks. Never claim to be a human.',
  );

  return lines.join('\n\n');
}

/**
 * `conversationHistory` comes back newest-first (see WhatsAppMessageRepository.listByChat)
 * and, because gatherAiHandoffContext runs after the triggering inbound
 * message is already persisted, its first element IS that message - so it
 * doubles as the final conversation turn. Reversed here into the
 * chronological order a real conversation actually happened in.
 */
function toContents(history: AiHandoffContext['conversationHistory']) {
  return history
    .filter((message) => Boolean(message.textContent))
    .slice()
    .reverse()
    .map((message) => ({
      role: message.fromMe ? ('model' as const) : ('user' as const),
      parts: [{ text: message.textContent as string }],
    }));
}

/**
 * Turns a real AiHandoffContext + agent configuration into an actual reply -
 * the piece `gatherAiHandoffContext`'s own doc comment calls "the Gemini
 * Orchestrator." Fails safe (returns 'unavailable', never throws) when the
 * API key is unset or the call itself fails: by the time this runs, the
 * inbound message is already safely persisted, so a reply is best-effort on
 * top of that, never a reason to break ingestion.
 */
export async function generateAiReply(agent: AiAgentRecord, context: AiHandoffContext): Promise<AiReplyResult> {
  const contents = toContents(context.conversationHistory);
  if (contents.length === 0) {
    return { status: 'unavailable', reason: 'No real message text to reply to' };
  }

  const genAi = getGeminiClient();
  if (!genAi) return { status: 'unavailable', reason: 'GEMINI_API_KEY is not configured' };

  const model = process.env.GEMINI_REPLY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  try {
    const response = await genAi.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: buildSystemInstruction(agent, context),
        temperature: 0.6,
        // A short WhatsApp reply doesn't need the model to reason before
        // answering, and those internal "thinking" tokens draw from the
        // same budget as the visible reply - left enabled, a real reply
        // could still be cut off mid-word even with a generous
        // maxOutputTokens. thinkingBudget: 0 is the SDK's own documented
        // way to disable it outright, removing the failure mode entirely
        // rather than just making it less likely.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 1024,
      },
    });

    const text = response.text?.trim();
    if (!text) return { status: 'unavailable', reason: 'Reply model returned an empty response' };

    return { status: 'generated', text: text.slice(0, MAX_REPLY_CHARS) };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `Reply model call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
