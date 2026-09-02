import { bimpayProvider } from './bimpayProvider.js';
import type { PaymentProviderAdapter } from './types.js';

const providers: Record<string, PaymentProviderAdapter> = {
  bimpay: bimpayProvider,
};

export function resolveProvider(kind: string): PaymentProviderAdapter | undefined {
  return providers[kind];
}
