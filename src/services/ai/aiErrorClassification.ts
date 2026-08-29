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

const MAX_CAUSE_DEPTH = 5;

/**
 * Node/undici wraps the real network cause under `.cause` (e.g. `TypeError:
 * fetch failed`), but a DNS/connection failure with multiple attempts often
 * makes that cause an AggregateError whose *own* `.code` is undefined - the
 * real code lives on one of its `.errors[]` entries instead, which the
 * original single-level `.cause.code` check could never see. Walks the
 * full chain (cause-of-cause, AggregateError.errors) up to a bounded depth,
 * not just one hop, so a network failure several layers deep is still
 * recognized as one instead of falling through to 'programming'.
 */
function networkCodeOf(error: unknown, depth = 0): string | undefined {
  if (!error || depth > MAX_CAUSE_DEPTH) return undefined;
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof candidate.code === 'string') return candidate.code;
  if (Array.isArray(candidate.errors)) {
    for (const inner of candidate.errors) {
      const found = networkCodeOf(inner, depth + 1);
      if (found) return found;
    }
  }
  if (candidate.cause) return networkCodeOf(candidate.cause, depth + 1);
  return undefined;
}

/**
 * Undici's fetch() throws exactly this TypeError, with this exact message,
 * only for a real network-level failure (DNS, TCP, TLS) - never for a bug
 * in this codebase's own request construction (a malformed URL throws
 * synchronously, with a different message, before any network attempt).
 * A safety net for the case above where even the recursive cause-walk
 * cannot find a recognized `.code` (an unfamiliar OS/runtime error shape) -
 * the message itself is still a reliable, narrow signal by construction.
 */
function isBareFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed';
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

  if (isBareFetchFailure(error)) {
    return { category: 'capacity', message: errorMessageOf(error) };
  }

  return { category: 'programming', message: errorMessageOf(error) };
}
