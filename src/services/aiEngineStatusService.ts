import { ApiError } from '@google/genai';
import { getGeminiClient } from './geminiClient.js';
import * as gooseService from './gooseService.js';

export type EngineState = 'configured' | 'available' | 'unavailable' | 'not_configured';
export interface EngineStatus { id: 'gemini' | 'goose'; label: string; role: 'primary' | 'failover'; state: EngineState; checkedBy: 'configuration' | 'live_probe'; reason?: string; }
export interface AiEngineStatus { engines: EngineStatus[]; canGenerate: boolean; }

/**
 * Global engine status - both engines are developer-provisioned secrets
 * (GEMINI_API_KEY, GOOSE_SERVICE_URL/GOOSE_SERVICE_API_KEY), never a
 * per-business setting. This used to also resolve a per-workspace Goose
 * override (business_goose_settings); removed for the same reason
 * providerAdapters.ts's GooseProvider dropped it (Section 117-122 security
 * review) - Goose is provisioned the same way as every other provider now.
 */
export async function getAiEngineStatus(): Promise<AiEngineStatus> {
  const geminiConfigured = getGeminiClient() !== null;
  const gemini: EngineStatus = {
    id: 'gemini', label: 'Gemini', role: 'primary', checkedBy: 'configuration',
    ...(geminiConfigured ? { state: 'configured' as const } : { state: 'not_configured' as const, reason: 'GEMINI_API_KEY is not set' }),
  };

  const health = await gooseService.healthCheck();
  const goose: EngineStatus = {
    id: 'goose', label: 'Goose', role: 'failover', state: health.status,
    checkedBy: health.status === 'not_configured' ? 'configuration' : 'live_probe',
    ...(health.reason ? { reason: health.reason } : {}),
  };

  return { engines: [gemini, goose], canGenerate: geminiConfigured || goose.state === 'available' };
}

export type GeminiTestResult = { status: 'ok'; detail: string } | { status: 'failed'; reason: string };

export async function testGeminiConnection(): Promise<GeminiTestResult> {
  const genAi = getGeminiClient();
  if (!genAi) return { status: 'failed', reason: 'GEMINI_API_KEY is not set' };
  const model = process.env.GEMINI_REPLY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const contents = [{ role: 'user' as const, parts: [{ text: 'Reply with the single word: ok' }] }];
  try {
    const response = await genAi.models.generateContent({ model, contents, config: { temperature: 0.6, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 16 } });
    if (!response.text?.trim()) return { status: 'failed', reason: `Model "${model}" accepted the request but returned no text.` };
    return { status: 'ok', detail: `Model "${model}" answered a real test call successfully, using the exact request shape real replies use.` };
  } catch (fullError) {
    const fullMessage = fullError instanceof Error ? fullError.message : String(fullError);
    if (fullError instanceof ApiError && fullError.status === 400) {
      try {
        const bareResponse = await genAi.models.generateContent({ model, contents });
        if (bareResponse.text?.trim()) return { status: 'ok', detail: `Model "${model}" works, but rejects the full config: ${fullMessage}. Real replies already recover automatically.` };
        return { status: 'failed', reason: `Bare request to "${model}" returned no text, and the full request failed: ${fullMessage}` };
      } catch (bareError) {
        return { status: 'failed', reason: `Model "${model}" is rejected even with a bare request: ${bareError instanceof Error ? bareError.message : String(bareError)}` };
      }
    }
    return { status: 'failed', reason: fullMessage };
  }
}
