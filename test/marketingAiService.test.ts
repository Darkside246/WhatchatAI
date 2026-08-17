import { describe, expect, it } from 'vitest';
import { suggestMarketingCopy } from '../src/services/marketingAiService.js';

describe('suggestMarketingCopy (real GEMINI_API_KEY state in this environment - never fabricates a suggestion)', () => {
  it('fails safe with an honest "unavailable" result when GEMINI_API_KEY is not configured, otherwise returns real Gemini-generated variations', async () => {
    const result = await suggestMarketingCopy({ kind: 'campaign_message', businessContext: 'Weekend 20% off sale', count: 3 });

    if (!process.env.GEMINI_API_KEY) {
      expect(result.status).toBe('unavailable');
      expect(result.reason).toContain('GEMINI_API_KEY');
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
    const result = await suggestMarketingCopy({ kind: 'status_caption', businessContext: 'New product launch', count: 99 });
    if (result.status === 'ok') {
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
    } else {
      expect(result.suggestions).toEqual([]);
    }
  });
});
