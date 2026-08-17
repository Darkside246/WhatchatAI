import { getGeminiClient } from './geminiClient.js';
import { workspaceService } from './workspaceService.js';

export type ReplySuggestionResult =
  | { status: 'ok'; suggestions: string[] }
  | { status: 'unavailable'; reason: string; suggestions: [] };

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 120;
const HISTORY_DEPTH = 10;

/**
 * Real Gemini-generated reply suggestions for the HUMAN agent to pick from -
 * never auto-sent, and never a canned fallback list. If Gemini is not
 * configured, or the conversation has no real inbound text to reply to, this
 * returns an honest "unavailable" the UI hides the bar for, exactly like
 * aiReplyService's own contract.
 *
 * Deliberately distinct from aiReplyService: that one composes a reply the
 * AI itself sends when a chat is in AI_ACTIVE mode. This one only ever
 * produces drafts a person chooses, so it stays available (and safe) even in
 * HUMAN_TAKEOVER chats where auto-reply is off.
 */
export async function suggestReplies(
  businessId: string,
  whatsappAccountId: string,
  chatId: string,
): Promise<ReplySuggestionResult> {
  const messages = await workspaceService.listMessages(businessId, whatsappAccountId, chatId, HISTORY_DEPTH);

  // listMessages returns newest-first; a suggestion only makes sense when the
  // most recent real message came FROM the customer.
  const withText = messages.filter((message) => Boolean(message.textContent));
  const latest = withText[0];
  if (!latest) return { status: 'unavailable', reason: 'No real message text to reply to', suggestions: [] };
  if (latest.fromMe) return { status: 'unavailable', reason: 'The last message was already ours', suggestions: [] };

  const genAi = getGeminiClient();
  if (!genAi) return { status: 'unavailable', reason: 'GEMINI_API_KEY is not configured', suggestions: [] };

  const transcript = withText
    .slice()
    .reverse()
    .map((message) => `${message.fromMe ? 'Business' : 'Customer'}: ${message.textContent}`)
    .join('\n');

  const model = process.env.GEMINI_REPLY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  try {
    const response = await genAi.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `Here is a real WhatsApp conversation between a business and a customer:\n\n${transcript}\n\n` +
                `Write ${MAX_SUGGESTIONS} short replies the business could send next.\n\n` +
                'Rules: one reply per line, no numbering, no quotation marks, no markdown. Keep each under ' +
                '15 words and WhatsApp-appropriate. Never invent facts, prices, order statuses, delivery ' +
                'dates, or promises that are not already present in the conversation above - if you cannot ' +
                'answer without inventing something, suggest asking the customer a clarifying question instead.',
            },
          ],
        },
      ],
      config: {
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 256,
      },
    });

    const text = response.text?.trim();
    if (!text) return { status: 'unavailable', reason: 'Model returned an empty response', suggestions: [] };

    const suggestions = text
      .split('\n')
      .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((line) => line.length > 0)
      .slice(0, MAX_SUGGESTIONS)
      .map((line) => line.slice(0, MAX_SUGGESTION_CHARS));

    if (suggestions.length === 0) {
      return { status: 'unavailable', reason: 'Model returned no usable suggestions', suggestions: [] };
    }
    return { status: 'ok', suggestions };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `Suggestion model call failed: ${error instanceof Error ? error.message : String(error)}`,
      suggestions: [],
    };
  }
}
