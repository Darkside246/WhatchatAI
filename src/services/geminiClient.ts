import { GoogleGenAI } from '@google/genai';

let client: GoogleGenAI | null = null;

/**
 * One real client per process, lazily created only once GEMINI_API_KEY is
 * actually present. Shared by every Gemini caller (the security Sentinel,
 * AI reply generation) so there is exactly one place that owns the API key
 * and client lifecycle. Callers get `null` when the key isn't configured
 * and must treat that as "AI unavailable" - never fabricate a result.
 */
export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}
