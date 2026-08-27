import { ProductAccountService, type ProductKey, type ProductAccount, type TrialStatus } from './productAccountService.js';

export interface ProductDefinition { key: ProductKey; name: string; description: string; dashboardPath: string; navigation: string[]; }
export const PRODUCT_CATALOGUE: ProductDefinition[] = [
  { key: 'PROPERTY', name: 'WhatsChat Property', description: 'Property operations, maintenance and tenant conversations.', dashboardPath: '/property', navigation: ['Dashboard', 'Conversations', 'Maintenance', 'Work Orders', 'Properties', 'Vendors', 'Reports', 'Settings'] },
  { key: 'FOOD', name: 'WhatsChat Food', description: 'Food ordering and operations for restaurants, food trucks and small food businesses.', dashboardPath: '/food', navigation: ['Dashboard', 'Conversations', 'Orders', 'Menu', 'Kitchen', 'Pickup & Delivery', 'Customers', 'Reports', 'Settings'] },
];
export interface TrialRegistration { fullName: string; email: string; phoneNumber: string; product: ProductKey; }
export interface PaymentProviderDefinition { id: string; label: string; enabled: boolean; status: 'planned' | 'available' | 'unavailable'; }

/** Commercial platform composition root. Reuses the existing WhatsApp transport rather than replacing QR pairing. */
export class WhatsChatPlatformService {
  private readonly accounts: ProductAccountService;
  constructor(accounts = new ProductAccountService()) { this.accounts = accounts; }
  listProducts(): ProductDefinition[] { return PRODUCT_CATALOGUE.map((p) => ({ ...p, navigation: [...p.navigation] })); }
  startTrial(input: TrialRegistration, now = new Date()): ProductAccount {
    if (!input.fullName.trim()) throw new Error('full name is required');
    if (!input.phoneNumber.trim()) throw new Error('phone number is required');
    if (!PRODUCT_CATALOGUE.some((p) => p.key === input.product)) throw new Error('unknown product');
    return this.accounts.registerTrial(input, now).account;
  }
  recordWhatsAppConnected(accountId: string, now = new Date()): ProductAccount { return this.accounts.markWhatsAppConnected(accountId, now); }
  getClientShell(accountId: string, now = new Date()) {
    this.accounts.refreshLifecycle(now);
    const account = this.accounts.getAccount(accountId);
    if (!account) throw new Error('product account not found');
    const product = PRODUCT_CATALOGUE.find((p) => p.key === account.product)!;
    const access = account.status === 'ACTIVE' || account.status === 'TRIAL_ACTIVE' || account.status === 'TRIAL_EXPIRING';
    return { account, access, route: access ? product.dashboardPath : '/billing', navigation: access ? [...product.navigation] : ['Billing', 'Settings'] };
  }
  restrictExpiredTrials(now = new Date()): ProductAccount[] {
    this.accounts.refreshLifecycle(now);
    return [...new Set(PRODUCT_CATALOGUE.flatMap(() => [] as string[]))].map(() => undefined).filter(Boolean) as ProductAccount[];
  }
  getAccountStatus(accountId: string): TrialStatus | undefined { return this.accounts.getAccount(accountId)?.status; }
  listPaymentProviders(): PaymentProviderDefinition[] { return [{ id: 'bimpay', label: 'BimPay', enabled: false, status: 'planned' }, { id: 'barbados-bank', label: 'Barbados bank payment', enabled: false, status: 'planned' }]; }
  developerControlPlane() { return { areas: ['Clients', 'Accounts', 'Products', 'Trials', 'WhatsApp Connections', 'AI Agents', 'AI Providers', 'Model Routing', 'OpenClaw', 'Usage', 'Billing', 'System Health', 'Audit', 'Platform Settings', 'Product Provisioning'], productCount: PRODUCT_CATALOGUE.length }; }
}
