import { ProductAccountService, type ProductKey, type ProductAccount } from './productAccountService.js';

export interface ProductDefinition {
  key: ProductKey;
  name: string;
  description: string;
  dashboardPath: string;
  navigation: string[];
}

export const PRODUCT_CATALOGUE: ProductDefinition[] = [
  { key: 'property', name: 'WhatsChat Property', description: 'Property operations, maintenance and tenant conversations.', dashboardPath: '/property', navigation: ['Dashboard', 'Conversations', 'Maintenance', 'Work Orders', 'Properties', 'Vendors', 'Reports', 'Settings'] },
  { key: 'food', name: 'WhatsChat Food', description: 'Food ordering and operations for restaurants, food trucks and small food businesses.', dashboardPath: '/food', navigation: ['Dashboard', 'Conversations', 'Orders', 'Menu', 'Kitchen', 'Pickup & Delivery', 'Customers', 'Reports', 'Settings'] },
];

export interface TrialRegistration {
  fullName: string;
  email: string;
  phoneNumber: string;
  product: ProductKey;
}

export interface PaymentProviderDefinition {
  id: string;
  label: string;
  enabled: boolean;
  status: 'planned' | 'available' | 'unavailable';
}

/**
 * Platform composition root for the commercial SaaS model. It deliberately
 * keeps payment providers abstract and reuses the existing WhatsApp transport
 * instead of owning or replacing QR/pairing behaviour.
 */
export class WhatsChatPlatformService {
  private readonly accounts: ProductAccountService;

  constructor(accounts = new ProductAccountService()) {
    this.accounts = accounts;
  }

  listProducts(): ProductDefinition[] {
    return PRODUCT_CATALOGUE.map((product) => ({ ...product, navigation: [...product.navigation] }));
  }

  startTrial(input: TrialRegistration, now = new Date()): ProductAccount {
    if (!input.fullName.trim()) throw new Error('full name is required');
    if (!input.phoneNumber.trim()) throw new Error('phone number is required');
    if (!this.listProducts().some((product) => product.key === input.product)) throw new Error('unknown product');
    return this.accounts.createTrial({ ownerName: input.fullName, email: input.email, phoneNumber: input.phoneNumber, product: input.product }, now);
  }

  recordWhatsAppConnected(accountId: string, connectionId: string): ProductAccount {
    return this.accounts.attachWhatsAppConnection(accountId, connectionId);
  }

  getClientShell(accountId: string, now = new Date()) {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error('product account not found');
    const state = this.accounts.evaluateLifecycle(accountId, now);
    const product = PRODUCT_CATALOGUE.find((entry) => entry.key === account.product)!;
    const access = state === 'ACTIVE' || state === 'TRIAL_ACTIVE' || state === 'TRIAL_EXPIRING';
    return {
      account,
      access,
      route: access ? product.dashboardPath : '/billing',
      navigation: access ? [...product.navigation] : ['Billing', 'Settings'],
    };
  }

  listPaymentProviders(): PaymentProviderDefinition[] {
    return [
      { id: 'bimpay', label: 'BimPay', enabled: false, status: 'planned' },
      { id: 'barbados-bank', label: 'Barbados bank payment', enabled: false, status: 'planned' },
    ];
  }

  developerControlPlane() {
    return {
      areas: ['Clients', 'Accounts', 'Products', 'Trials', 'WhatsApp Connections', 'AI Agents', 'AI Providers', 'Model Routing', 'OpenClaw', 'Usage', 'Billing', 'System Health', 'Audit', 'Platform Settings', 'Product Provisioning'],
      productCount: this.listProducts().length,
      accountCount: this.accounts.list().length,
    };
  }
}
