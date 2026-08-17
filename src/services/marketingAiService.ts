import { getGeminiClient } from './geminiClient.js';

export type MarketingCopyKind = 'campaign_message' | 'status_caption' | 'follow_up';

export interface SuggestMarketingCopyInput {
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
 * Real Gemini-generated copy suggestions - never a canned template. When
 * Gemini isn't configured, this returns an honest "unavailable" the caller
 * must surface as such, exactly like aiReplyService's own contract - never
 * a fabricated suggestion.
 */
export async function suggestMarketingCopy(input: SuggestMarketingCopyInput): Promise<SuggestMarketingCopyResult> {
  const genAi = getGeminiClient();
  if (!genAi) return { status: 'unavailable', reason: 'GEMINI_API_KEY is not configured', suggestions: [] };

  const count = Math.min(Math.max(input.count ?? 3, 1), 5);
  const model = process.env.GEMINI_MARKETING_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  try {
    const response = await genAi.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `Write ${count} distinct variations of ${KIND_INSTRUCTION[input.kind]}: "${input.businessContext}"\n\n` +
                'Rules: each variation on its own line, no numbering, no quotation marks, no markdown, ' +
                'friendly and concise (WhatsApp-appropriate length), and never invent facts, prices, or offers not stated above.',
            },
          ],
        },
      ],
      config: {
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 512,
      },
    });

    const text = response.text?.trim();
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
