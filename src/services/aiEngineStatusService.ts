import { ApiError } from '@google/genai';
import { getGeminiClient } from './geminiClient.js';
import * as gooseService from './gooseService.js';
import { IntegrationSettingsRepository } from '../repositories/integrationSettingsRepository.js';
import { pool } from '../db/pool.js';

export type EngineState = 'configured' | 'available' | 'unavailable' | 'not_configured';

export interface EngineStatus {
  id: 'gemini' | 'goose';
  label: string;
  role: 'primary' | 'failover';
  state: EngineState;
  checkedBy: 'configuration' | 'live_probe';
  reason?: string;
}

export interface AiEngineStatus { engines: EngineStatus[]; canGenerate: boolean; }

/**
 * Reports the engine state for the authenticated workspace. Goose settings
 * saved in Settings are authoritative when a workspace row exists. The
 * process environment remains a backwards-compatible fallback only when no
 * workspace Goose row exists.
 */
export async function getAiEngineStatus(businessId: string): Promise<AiEngineStatus> {
  const geminiConfigured = getGeminiClient() !== null;
  const gemini: EngineStatus = {
    id: 'gemini', label: 'Gemini', role: 'primary', checkedBy: 'configuration',
    ...(geminiConfigured ? { state: 'configured' as const } : { state: 'not_configured' as const, reason: 'GEMINI_API_KEY is not set' }),
  };

  const settings = await new IntegrationSettingsRepository(pool).getGooseResolved(businessId);
  const workspaceEndpoint = settings?.isEnabled && settings.serviceUrl
    ? { serviceUrl: settings.serviceUrl, apiKey: settings.apiKey }
    : undefined;

  let goose: EngineStatus;
  if (settings && !settings.isEnabled) {
    goose = { id: 'goose', label: 'Goose', role: 'failover', state: 'not_configured', checkedBy: 'configuration', reason: 'Goose failover is disabled for this workspace' };
  } else if (workspaceEndpoint) {
    const health = await gooseService.healthCheck(workspaceEndpoint);
    goose = { id: 'goose', label: 'Goose', role: 'failover', state: health.status, checkedBy: health.status === 'not_configured' ? 'configuration' : 'live_probe', ...(health.reason ? { reason: health.reason } : {}) };
  } else {
    const health = await gooseService.healthCheck();
    goose = { id: 'goose', label: 'Goose', role: 'failover', state: health.status, checkedBy: health.status === 'not_configured' ? 'configuration' : 'live_probe', ...(health.reason ? { reason: health.reason } : {}) };
  }

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
