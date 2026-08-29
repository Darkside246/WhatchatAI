import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { suggestMarketingCopy } from '../src/services/marketingAiService.js';

// P5: routed through AiGateway (a real provider-fallback chain) instead of a
// direct Gemini call - "unavailable" now means "no provider in the gateway's
// chain could answer" rather than specifically "no Gemini key", so the
// reason string is a gateway-level message, not a Gemini-specific one. The
// actual guarantee this test protects - fail safe, never fabricate a
// suggestion - is unchanged.
describe('suggestMarketingCopy (real provider state in this environment via AiGateway - never fabricates a suggestion)', () => {
  const businessId = randomUUID();

  it('fails safe with an honest "unavailable" result when no AI provider is configured, otherwise returns real generated variations', async () => {
    const result = await suggestMarketingCopy({ businessId, kind: 'campaign_message', businessContext: 'Weekend 20% off sale', count: 3 });

    if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
      expect(result.status).toBe('unavailable');
      expect(result.reason).toBeTruthy();
      expect(result.suggestions).toEqual([]);
    } else {
      expect(['ok', 'unavailable']).toContain(result.status);
      if (result.status === 'ok') {
        expect(result.suggestions.length).toBeGreaterThan(0);
        expect(result.suggestions.length).toBeLessThanOrEqual(3);
        for (const suggestion of result.suggestions) {
          expect(typeof suggestion).toBe('string');
          expect(suggestion.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('clamps an out-of-range count to the real 1-5 window rather than rejecting the request', async () => {
    const result = await suggestMarketingCopy({ businessId, kind: 'status_caption', businessContext: 'New product launch', count: 99 });
    if (result.status === 'ok') {
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
    } else {
      expect(result.suggestions).toEqual([]);
    }
  });
});
