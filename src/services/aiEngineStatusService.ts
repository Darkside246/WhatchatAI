import { getGeminiClient } from './geminiClient.js';
import * as gooseService from './gooseService.js';

/**
 * Honest reporting of which engine can actually answer a customer right now.
 *
 * Deliberate design point: we do NOT make a real Gemini generation call to
 * probe it. That would spend the operator's quota on every page load, and a
 * key can be present but rejected only at call time - so a "green" here
 * would be a promise we cannot keep either way. Instead Gemini reports
 * whether it is genuinely configured, and the label says exactly that.
 * Goose is a service we host, so probing it is cheap and its result is a
 * real reachability check.
 */
export type EngineState = 'configured' | 'available' | 'unavailable' | 'not_configured';

export interface EngineStatus {
  /** Stable id for the UI; not a display string. */
  id: 'gemini' | 'goose';
  label: string;
  role: 'primary' | 'failover';
  state: EngineState;
  /** How the state was established, so the UI never implies more certainty than we have. */
  checkedBy: 'configuration' | 'live_probe';
  reason?: string;
}

export interface AiEngineStatus {
  engines: EngineStatus[];
  /**
   * True only when at least one engine could plausibly answer. When false,
   * AI replies genuinely cannot be produced and the operator needs to know
   * before a customer discovers it.
   */
  canGenerate: boolean;
}

export async function getAiEngineStatus(): Promise<AiEngineStatus> {
  const geminiConfigured = getGeminiClient() !== null;
  const gemini: EngineStatus = {
    id: 'gemini',
    label: 'Gemini',
    role: 'primary',
    checkedBy: 'configuration',
    ...(geminiConfigured
      ? { state: 'configured' as const }
      : { state: 'not_configured' as const, reason: 'GEMINI_API_KEY is not set' }),
  };

  const gooseHealth = await gooseService.healthCheck();
  const goose: EngineStatus = {
    id: 'goose',
    label: 'Goose',
    role: 'failover',
    // 'not_configured' is settled without any network call; the other two
    // states come from a real HTTP probe of the configured service.
    checkedBy: gooseHealth.status === 'not_configured' ? 'configuration' : 'live_probe',
    state: gooseHealth.status,
    ...(gooseHealth.reason !== undefined && { reason: gooseHealth.reason }),
  };

  return {
    engines: [gemini, goose],
    canGenerate: geminiConfigured || goose.state === 'available',
  };
}

export type GeminiTestResult = { status: 'ok'; detail: string } | { status: 'failed'; reason: string };

/**
 * The real test getAiEngineStatus deliberately does not run: one minimal,
 * cheap live call to prove the key actually works, not just that it exists.
 * A key can be present but revoked, malformed, from the wrong project, or
 * out of quota - "configured" cannot tell those apart from a working key,
 * only an actual call can. Kept to the smallest possible request
 * (thinkingBudget: 0, a few output tokens) since this spends real quota.
 */
export async function testGeminiConnection(): Promise<GeminiTestResult> {
  const genAi = getGeminiClient();
  if (!genAi) return { status: 'failed', reason: 'GEMINI_API_KEY is not set' };

  try {
    const model = process.env.GEMINI_REPLY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    const response = await genAi.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      config: { temperature: 0, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 16 },
    });
    if (!response.text?.trim()) {
      return { status: 'failed', reason: 'The API accepted the request but returned no text - check the model name and account access.' };
    }
    return { status: 'ok', detail: `Model "${model}" answered a real test call successfully.` };
  } catch (error) {
    // The literal provider error, not a paraphrase - this is the one place
    // an operator can see whether their key is invalid, unauthorized,
    // rate-limited, or points at a model they don't have access to.
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
