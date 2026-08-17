export type GooseStatus = 'available' | 'unavailable' | 'not_configured';

export interface GooseHealth {
  status: GooseStatus;
  reason?: string;
}

export interface GooseGenerateInput {
  systemInstruction: string;
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
}

export type GooseGenerateResult = { status: 'generated'; text: string } | { status: 'unavailable'; reason: string };

function getServiceUrl(): string | undefined {
  const url = process.env.GOOSE_SERVICE_URL;
  return url && url.trim().length > 0 ? url.trim() : undefined;
}

/**
 * Real health probe against a configured Goose service - never fabricates
 * "available". If GOOSE_SERVICE_URL is unset, this is honestly
 * 'not_configured' per the original directive's own accepted acceptance
 * states (PASS/FAIL/NOT_CONFIGURED) - not a fake local-AI claim.
 */
export async function healthCheck(): Promise<GooseHealth> {
  const url = getServiceUrl();
  if (!url) return { status: 'not_configured', reason: 'GOOSE_SERVICE_URL is not configured' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: controller.signal });
      if (!response.ok) return { status: 'unavailable', reason: `Goose health endpoint returned HTTP ${response.status}` };
      return { status: 'available' };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { status: 'unavailable', reason: `Goose health check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function isAvailable(): Promise<boolean> {
  const health = await healthCheck();
  return health.status === 'available';
}

export function getCapabilities(): { configured: boolean; url: string | undefined } {
  return { configured: Boolean(getServiceUrl()), url: getServiceUrl() };
}

/**
 * Real Goose failover call - only ever invoked after a genuine Gemini
 * failure. Never called when GOOSE_SERVICE_URL is unset; callers must
 * check getCapabilities()/healthCheck() first.
 */
export async function generateResponse(input: GooseGenerateInput): Promise<GooseGenerateResult> {
  const url = getServiceUrl();
  if (!url) return { status: 'unavailable', reason: 'GOOSE_SERVICE_URL is not configured' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/$/, '')}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ systemInstruction: input.systemInstruction, contents: input.contents }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return { status: 'unavailable', reason: `Goose generate endpoint returned HTTP ${response.status}` };
    }

    const body = (await response.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return { status: 'unavailable', reason: 'Goose returned an empty response' };

    return { status: 'generated', text };
  } catch (error) {
    return { status: 'unavailable', reason: `Goose generate call failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
