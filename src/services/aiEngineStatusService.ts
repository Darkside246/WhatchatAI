import { ApiError } from '@google/genai';
import { getGeminiClient } from './geminiClient.js';
import * as gooseService from './gooseService.js';
import { IntegrationSettingsRepository } from '../repositories/integrationSettingsRepository.js';
import { pool } from '../db/pool.js';

export type EngineState = 'configured' | 'available' | 'unavailable' | 'not_configured';
export interface EngineStatus { id: 'gemini' | 'goose'; label: string; role: 'primary' | 'failover'; state: EngineState; checkedBy: 'configuration' | 'live_probe'; reason?: string; }
export interface AiEngineStatus { engines: EngineStatus[]; canGenerate: boolean; }

/**
 * Workspace-aware engine status. Routes that have a workspace id should pass
 * it. The legacy global route may omit it, in which case workspace Goose is
 * used only when exactly one workspace has a stored configuration; otherwise
 * we fall back to process configuration without exposing another tenant's
 * settings.
 */
export async function getAiEngineStatus(businessId?: string): Promise<AiEngineStatus> {
  const geminiConfigured = getGeminiClient() !== null;
  const gemini: EngineStatus = {
    id: 'gemini', label: 'Gemini', role: 'primary', checkedBy: 'configuration',
    ...(geminiConfigured ? { state: 'configured' as const } : { state: 'not_configured' as const, reason: 'GEMINI_API_KEY is not set' }),
  };

  const repository = new IntegrationSettingsRepository(pool);
  let settings = businessId ? await repository.getGooseResolved(businessId) : null;
  if (!businessId) {
    const { rows } = await pool.query<{ business_id: string; is_enabled: boolean; service_url: string | null }>(
      'SELECT business_id, is_enabled, service_url FROM business_goose_settings ORDER BY updated_at DESC LIMIT 2',
    );
    if (rows.length === 1) {
      const row = rows[0]!;
      settings = await repository.getGooseResolved(row.business_id);
    }
  }

  let goose: EngineStatus;
  if (settings && !settings.isEnabled) {
    goose = { id: 'goose', label: 'Goose', role: 'failover', state: 'not_configured', checkedBy: 'configuration', reason: 'Goose failover is disabled for this workspace' };
  } else if (settings?.isEnabled && settings.serviceUrl) {
    const health = await gooseService.healthCheck({ serviceUrl: settings.serviceUrl, apiKey: settings.apiKey });
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
