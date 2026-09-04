import { resolveProvider } from './providers/registry.js';
import { PlatformSettingsRepository } from '../../repositories/platformSettingsRepository.js';
import { pool } from '../../db/pool.js';

const platformSettingsRepository = new PlatformSettingsRepository(pool);

export const PAYMENT_PROVIDER_KINDS = ['bimpay', 'paypal', 'wipay'] as const;

/** Does this provider have the real credentials it needs to function at all - independent of whether a developer has since switched it off (see isProviderEnabled). WiPay is never configured until its real integration replaces the deliberate stub in wipayProvider.ts. */
export function isProviderConfigured(providerKind: string): boolean {
  if (providerKind === 'bimpay') return Boolean(process.env.BIMPAY_BRIDGE_SECRET?.trim());
  if (providerKind === 'paypal') return Boolean(process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim() && process.env.PAYPAL_WEBHOOK_ID?.trim());
  return false;
}

/** The live Control Plane toggle (platform_settings) - defaults to enabled once a provider is configured, so setting up real credentials is enough on its own; a developer can still switch a configured provider off instantly without touching env vars or redeploying. */
export async function isProviderEnabled(providerKind: string): Promise<boolean> {
  const setting = await platformSettingsRepository.get(`payment_provider:${providerKind}`);
  if (!setting) return true;
  const value = setting.value as { enabled?: unknown };
  return value.enabled !== false;
}

export async function isProviderUsable(providerKind: string): Promise<boolean> {
  return resolveProvider(providerKind) !== undefined && isProviderConfigured(providerKind) && (await isProviderEnabled(providerKind));
}
