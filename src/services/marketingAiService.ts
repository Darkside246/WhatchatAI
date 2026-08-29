import { aiGateway } from './ai/aiGateway.js';

export type MarketingCopyKind = 'campaign_message' | 'status_caption' | 'follow_up';

export interface SuggestMarketingCopyInput {
  businessId: string;
  kind: MarketingCopyKind;
  businessContext: string;
  count?: number | undefined;
}

export interface SuggestMarketingCopyResult {
  status: 'ok' | 'unavailable';
  reason?: string;
  suggestions: string[];
}

const KIND_INSTRUCTION: Record<MarketingCopyKind, string> = {
  campaign_message: 'a short WhatsApp broadcast message to real existing customers announcing this',
  status_caption: 'a short WhatsApp Status caption about this',
  follow_up: 'a short, friendly WhatsApp follow-up message about this',
};

/**
 * Real AiGateway-generated copy suggestions - never a canned template.
 * Routed through AiGateway (P5), so a Gemini outage falls back through
 * OpenAI/OpenRouter/Goose instead of going straight to "unavailable". If no
 * provider can answer, this returns an honest "unavailable" the caller must
 * surface as such - never a fabricated suggestion. Input is the operator's
 * own typed campaign brief, not customer data - no injection boundary
 * needed here the way replySuggestionService needs one for a customer transcript.
 */
export async function suggestMarketingCopy(input: SuggestMarketingCopyInput): Promise<SuggestMarketingCopyResult> {
  const count = Math.min(Math.max(input.count ?? 3, 1), 5);

  try {
    const response = await aiGateway.generate({
      tenantId: input.businessId,
      operation: 'marketing.suggest',
      messages: [
        {
          role: 'user',
          content:
            `Write ${count} distinct variations of ${KIND_INSTRUCTION[input.kind]}: "${input.businessContext}"\n\n` +
            'Rules: each variation on its own line, no numbering, no quotation marks, no markdown, ' +
            'friendly and concise (WhatsApp-appropriate length), and never invent facts, prices, or offers not stated above.',
        },
      ],
      temperature: 0.8,
      maxOutputTokens: 512,
    });

    const text = response.text.trim();
    if (!text) return { status: 'unavailable', reason: 'Model returned an empty response', suggestions: [] };

    const suggestions = text
      .split('\n')
      .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((line) => line.length > 0)
      .slice(0, count);

    if (suggestions.length === 0) return { status: 'unavailable', reason: 'Model returned no usable suggestions', suggestions: [] };
    return { status: 'ok', suggestions };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error), suggestions: [] };
  }
}
