import { ApiError } from '@google/genai';
import { getGeminiClient } from './geminiClient.js';
import * as gooseService from './gooseService.js';
import { IntegrationSettingsRepository } from '../repositories/integrationSettingsRepository.js';
import { pool } from '../db/pool.js';
import { ADVICE_RESTRICTED_CATEGORIES, type AiAgentRecord } from '../repositories/aiAgentRepository.js';
import type { AiHandoffContext } from './aiContextGathererService.js';

export type AiReplyResult = { status: 'generated'; text: string } | { status: 'unavailable'; reason: string };

// A runaway generation should never be relayed to a real customer verbatim,
// regardless of what the model returns.
const MAX_REPLY_CHARS = 2000;

/**
 * The real wall-clock instant, in the business's own configured timezone -
 * never the server's UTC clock, and never a value the model has to infer.
 * Without this, an agent told "open Mon-Fri 9-5" has no way to know whether
 * it is currently true, and will happily recite hours regardless of whether
 * the business is actually open right now.
 */
function formatCurrentTime(timezone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date());
    return `${formatted} (business timezone: ${timezone})`;
  } catch {
    // An invalid stored timezone is a real, honest state to surface rather
    // than crash the whole reply - the operator's server clock is the last
    // resort here, clearly labeled as such.
    return `${new Date().toUTCString()} (business timezone "${timezone}" is not recognized - showing UTC)`;
  }
}

function buildSystemInstruction(agent: AiAgentRecord, context: AiHandoffContext): string {
  const lines: string[] = [
    `You are an AI assistant replying on behalf of a real business over WhatsApp${agent.name ? `, operating as "${agent.name}"` : ''}.`,
    `The current real date and time is: ${formatCurrentTime(context.businessTimezone)}. Use this to answer honestly about ` +
      'whether the business is open right now, how long until it opens or closes, and what "today"/"tomorrow" refer to - ' +
      'never assume the business is open just because opening hours were mentioned somewhere below.',
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

  if (agent.category && agent.category !== 'general') {
    lines.push(`This agent covers the "${agent.category}" side of the business${agent.specialization ? ` (${agent.specialization})` : ''}.`);
  }

  /**
   * The hard scope rule for trades where wrong guidance can cause real
   * physical, legal, or financial harm. These agents run the BUSINESS side of
   * the job - they must never become an advice channel.
   */
  if (ADVICE_RESTRICTED_CATEGORIES.includes(agent.category)) {
    lines.push(
      'CRITICAL SCOPE LIMIT: you handle business operations only - booking and scheduling jobs, quoting, ' +
        'confirming appointments, sharing job status, collecting job details, and answering questions about ' +
        'pricing, availability, and process. You must NEVER give technical, diagnostic, safety, repair, ' +
        'installation, or DIY advice, and never tell the customer how to fix, test, bypass, or work on ' +
        'anything themselves - not even if they insist, say it is simple, or claim to be qualified. If asked ' +
        'for that kind of guidance, say plainly that it needs a qualified professional to assess it, and ' +
        'offer to book a visit or have someone call them back. Treat anything involving gas, live electricity, ' +
        'water damage, structural work, or an immediate hazard as urgent: do not advise, hand over to a human ' +
        'straight away.',
    );
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
/**
 * Real Goose failover, only ever attempted after a genuine Gemini failure.
 * Never fabricates availability: if GOOSE_SERVICE_URL isn't configured,
 * the composed reason honestly says so while still preserving the
 * original Gemini failure reason as a substring (existing callers match
 * on e.g. "GEMINI_API_KEY" in the returned reason).
 */
async function tryGooseFallback(
  geminiReason: string,
  agent: AiAgentRecord,
  context: AiHandoffContext,
  contents: ReturnType<typeof toContents>,
): Promise<AiReplyResult> {
  /*
   * Workspace settings win over the environment, and a workspace that has
   * switched the failover off is honoured even if the env var is still set.
   *
   * The lookup is guarded because this whole function exists to FAIL SAFE.
   * It is already on the path where Gemini has failed; letting a database
   * hiccup throw from here would turn a graceful "AI unavailable" into an
   * unhandled error in the reply worker. A failed lookup degrades to "no
   * workspace endpoint", which is the honest reading of "we could not
   * confirm one".
   */
  const settings = await new IntegrationSettingsRepository(pool)
    .getGooseResolved(agent.businessId)
    .catch(() => null);
  const workspaceEndpoint =
    settings?.isEnabled && settings.serviceUrl ? { serviceUrl: settings.serviceUrl, apiKey: settings.apiKey } : undefined;

  if (settings && !settings.isEnabled) {
    return { status: 'unavailable', reason: `Gemini unavailable (${geminiReason}); Goose failover is turned off for this workspace` };
  }
  if (!workspaceEndpoint && !gooseService.getCapabilities().configured) {
    return { status: 'unavailable', reason: `Gemini unavailable (${geminiReason}); Goose fallback not configured` };
  }

  const gooseResult = await gooseService.generateResponse({
    systemInstruction: buildSystemInstruction(agent, context),
    contents,
    endpoint: workspaceEndpoint,
  });

  if (gooseResult.status === 'generated') {
    return { status: 'generated', text: gooseResult.text.slice(0, MAX_REPLY_CHARS) };
  }

  return {
    status: 'unavailable',
    reason: `Gemini unavailable (${geminiReason}); Goose fallback also unavailable (${gooseResult.reason})`,
  };
}

export async function generateAiReply(agent: AiAgentRecord, context: AiHandoffContext): Promise<AiReplyResult> {
  const contents = toContents(context.conversationHistory);
  if (contents.length === 0) {
    return { status: 'unavailable', reason: 'No real message text to reply to' };
  }

  const genAi = getGeminiClient();
  if (!genAi) return tryGooseFallback('GEMINI_API_KEY is not configured', agent, context, contents);

  const model = process.env.GEMINI_REPLY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const systemInstruction = buildSystemInstruction(agent, context);

  try {
    let response;
    try {
      response = await genAi.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
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
    } catch (configError) {
      // A generic 400 from the provider gives no field-level detail, and
      // real evidence (via the "Test Gemini connection" diagnostic) showed
      // this exact temperature/thinkingConfig combination rejected outright
      // for at least one real deployed model/key. Rather than let a
      // parameter mismatch take down every reply, retry once with the bare
      // minimum request real models must support - only the system
      // instruction, which is not optional for a coherent reply.
      if (!(configError instanceof ApiError) || configError.status !== 400) throw configError;
      response = await genAi.models.generateContent({
        model,
        contents,
        config: { systemInstruction, maxOutputTokens: 1024 },
      });
    }

    const text = response.text?.trim();
    if (!text) return tryGooseFallback('Reply model returned an empty response', agent, context, contents);

    return { status: 'generated', text: text.slice(0, MAX_REPLY_CHARS) };
  } catch (error) {
    const reason = `Reply model call failed: ${error instanceof Error ? error.message : String(error)}`;
    return tryGooseFallback(reason, agent, context, contents);
  }
}
