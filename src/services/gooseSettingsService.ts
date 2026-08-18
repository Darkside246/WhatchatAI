import { pool } from '../db/pool.js';
import { IntegrationSettingsRepository, type GooseSettingsPublic } from '../repositories/integrationSettingsRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';

const integrationSettingsRepository = new IntegrationSettingsRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

const PROBE_TIMEOUT_MS = 5000;

/**
 * Per-workspace Goose configuration.
 *
 * Important, and stated in the UI too: this URL is NOT a plain Goose
 * install. Goose exposes a CLI, an ACP server over stdio, and chat-platform
 * gateways - none of which is the HTTP contract this app calls. Something
 * must sit in front of it implementing GET /health and POST /generate.
 * See docs/reference/goose-integration.md.
 */
export async function getGooseSettings(businessId: string): Promise<GooseSettingsPublic> {
  const stored = await integrationSettingsRepository.getGoosePublic(businessId);
  return (
    stored ?? {
      isEnabled: false,
      serviceUrl: null,
      apiKeySet: false,
      lastTestAt: null,
      lastTestOk: null,
      lastTestError: null,
    }
  );
}

export async function updateGooseSettings(
  businessId: string,
  updatedBy: string,
  input: { isEnabled: boolean; serviceUrl?: string | null | undefined; apiKey?: string | null | undefined },
): Promise<GooseSettingsPublic> {
  const serviceUrl = input.serviceUrl?.trim() || null;

  if (input.isEnabled && !serviceUrl) {
    throw new Error('INVALID: A service URL is required to enable the Goose failover.');
  }
  if (serviceUrl) {
    try {
      const parsed = new URL(serviceUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('INVALID: The service URL must be http or https.');
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID:')) throw error;
      throw new Error('INVALID: That service URL is not a valid URL.');
    }
  }

  await integrationSettingsRepository.upsertGoose({
    businessId,
    isEnabled: input.isEnabled,
    serviceUrl,
    apiKey: input.apiKey,
  });

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'goose_settings_updated',
    rawMetadata: { updatedBy, isEnabled: input.isEnabled, serviceUrl },
  });

  return getGooseSettings(businessId);
}

export type GooseTestResult = { status: 'ok'; detail: string } | { status: 'failed'; reason: string };

/**
 * A real HTTP probe of the configured service, recorded so the screen can
 * report a genuine past result rather than inferring health from a URL being
 * filled in.
 */
export async function testGooseSettings(businessId: string, requestedBy: string): Promise<GooseTestResult> {
  const settings = await integrationSettingsRepository.getGooseResolved(businessId);
  if (!settings?.serviceUrl) return { status: 'failed', reason: 'No service URL is configured.' };

  let result: GooseTestResult;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${settings.serviceUrl.replace(/\/$/, '')}/health`, {
        signal: controller.signal,
        headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
      });
      result = response.ok
        ? { status: 'ok', detail: `The service answered /health with HTTP ${response.status}.` }
        : { status: 'failed', reason: `The service answered /health with HTTP ${response.status}.` };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    result = { status: 'failed', reason: `Could not reach the service: ${error instanceof Error ? error.message : String(error)}` };
  }

  await integrationSettingsRepository.recordGooseTest(businessId, result.status === 'ok', result.status === 'ok' ? null : result.reason);
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'goose_tested',
    rawMetadata: { requestedBy, ok: result.status === 'ok' },
  });

  return result;
}
