import { bimpayProvider } from './bimpayProvider.js';
import { paypalProvider } from './paypalProvider.js';
import { wipayProvider } from './wipayProvider.js';
import type { PaymentProviderAdapter } from './types.js';

const providers: Record<string, PaymentProviderAdapter> = {
  bimpay: bimpayProvider,
  paypal: paypalProvider,
  wipay: wipayProvider,
};

export function resolveProvider(kind: string): PaymentProviderAdapter | undefined {
  return providers[kind];
}
