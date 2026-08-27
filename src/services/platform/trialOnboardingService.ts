import type { ProductKey } from './productAccountService.js';

export type OnboardingStep = 'LANDING' | 'REGISTRATION' | 'TRIAL_ACTIVE' | 'WHATSAPP_CONNECTION' | 'DASHBOARD' | 'PAYMENT_REQUIRED';
export interface OnboardingState { step: OnboardingStep; product: ProductKey; accountId: string | null; message: string; }

/** UI-agnostic onboarding state machine for the public landing and existing QR connection flow. */
export class TrialOnboardingService {
  selectProduct(product: ProductKey): OnboardingState { return { step: 'REGISTRATION', product, accountId: null, message: 'Create your account to start your 48-hour trial.' }; }
  trialActivated(product: ProductKey, accountId: string): OnboardingState { return { step: 'WHATSAPP_CONNECTION', product, accountId, message: 'Your 48-hour trial has started. Connect WhatsApp to continue.' }; }
  whatsappConnected(product: ProductKey, accountId: string): OnboardingState { return { step: 'DASHBOARD', product, accountId, message: 'WhatsApp connected. Your dashboard is ready.' }; }
  paymentRequired(product: ProductKey, accountId: string): OnboardingState { return { step: 'PAYMENT_REQUIRED', product, accountId, message: 'Your trial has ended. Choose a payment method to reactivate your account.' }; }
}
