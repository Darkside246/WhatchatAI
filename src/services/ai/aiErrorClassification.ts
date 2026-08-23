import { ApiError } from '@google/genai';

/**
 * The five-way taxonomy from docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md
 * section 3, built from the real branches an @google/genai call can
 * actually produce (confirmed by reading the SDK's own throwErrorIfNotOK -
 * any HTTP response in [400,600) becomes an ApiError with a real `.status`;
 * anything else - a network-level fetch failure, a bug in this codebase's
 * own request construction - propagates as a plain (non-ApiError) thrown
 * value).
 */
export type AiErrorCategory = 'capacity' | 'auth' | 'malformed_request' | 'provider_config' | 'programming';

export interface ClassifiedAiError {
  category: AiErrorCategory;
  message: string;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Node/undici often wraps the real network cause under `.cause` (e.g. `TypeError: fetch failed`). */
function networkCodeOf(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate?.code === 'string') return candidate.code;
  if (typeof candidate?.cause?.code === 'string') return candidate.cause.code;
  return undefined;
}

/**
 * Classifies a real thrown value from a Gemini call into the taxonomy
 * above. Deliberately conservative: an HTTP status this function does not
 * recognize is classified 'programming' rather than guessed as capacity or
 * config - a wrong guess there is worse than failing loud (see the
 * Phase 3B safeguard: an internal/unrecognized failure must never be
 * silently disguised as an ordinary provider failure).
 */
export function classifyAiError(error: unknown): ClassifiedAiError {
  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return { category: 'capacity', message: error.message };
    }
    if (status === 401 || status === 403) {
      return { category: 'auth', message: error.message };
    }
    if (status === 400) {
      return { category: 'malformed_request', message: error.message };
    }
    if (status === 404) {
      return { category: 'provider_config', message: error.message };
    }
    return { category: 'programming', message: `Unrecognized Gemini API status ${status}: ${error.message}` };
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return { category: 'capacity', message: errorMessageOf(error) || 'Request aborted (timeout)' };
  }

  const networkCode = networkCodeOf(error);
  if (networkCode && NETWORK_ERROR_CODES.has(networkCode)) {
    return { category: 'capacity', message: errorMessageOf(error) };
  }

  return { category: 'programming', message: errorMessageOf(error) };
}
