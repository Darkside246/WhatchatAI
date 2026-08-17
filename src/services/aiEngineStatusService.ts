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
