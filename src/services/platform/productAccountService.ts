import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ProductKeySchema = z.enum(['PROPERTY', 'FOOD']);
export type ProductKey = z.infer<typeof ProductKeySchema>;

export const TrialStatusSchema = z.enum([
  'TRIAL_CREATED',
  'TRIAL_ACTIVE',
  'TRIAL_EXPIRING',
  'TRIAL_EXPIRED',
  'ACTIVE',
  'RESTRICTED',
]);
export type TrialStatus = z.infer<typeof TrialStatusSchema>;

export const PlatformIdentitySchema = z.object({
  id: z.string(),
  fullName: z.string().min(1),
  email: z.string().email(),
  phoneNumber: z.string().min(1),
  createdAt: z.string(),
});
export type PlatformIdentity = z.infer<typeof PlatformIdentitySchema>;

export const ProductAccountSchema = z.object({
  id: z.string(),
  identityId: z.string(),
  tenantId: z.string(),
  product: ProductKeySchema,
  status: TrialStatusSchema,
  trialStartedAt: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  whatsappConnectedAt: z.string().nullable(),
  restrictedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ProductAccount = z.infer<typeof ProductAccountSchema>;

export interface TrialRegistrationInput {
  fullName: string;
  email: string;
  phoneNumber: string;
  product: ProductKey;
}

export interface TrialRegistrationResult {
  identity: PlatformIdentity;
  account: ProductAccount;
}

/**
 * Platform-level commercial account lifecycle.
 *
 * A person may own multiple product accounts, but each account has its own
 * tenant boundary, WhatsApp connection and product entitlement. The trial
 * rule is deliberately enforced against the normalized identity email across
 * the whole platform: one email receives one 48-hour trial, regardless of
 * product.
 *
 * This service is intentionally persistence-agnostic. Repositories can back
 * it with PostgreSQL later without changing the lifecycle contract.
 */
export class ProductAccountService {
  private readonly identitiesByEmail = new Map<string, PlatformIdentity>();
  private readonly accounts = new Map<string, ProductAccount>();
  private readonly trialConsumedEmails = new Set<string>();

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  registerTrial(input: TrialRegistrationInput, now = new Date()): TrialRegistrationResult {
    const normalizedEmail = this.normalizeEmail(input.email);
    if (!normalizedEmail) throw new Error('email is required');
    if (this.trialConsumedEmails.has(normalizedEmail)) {
      throw new Error('trial already used for this email');
    }

    const identity = this.getOrCreateIdentity({ ...input, email: normalizedEmail }, now);
    const trialStartedAt = now.toISOString();
    const trialEndsAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
    const account = ProductAccountSchema.parse({
      id: randomUUID(),
      identityId: identity.id,
      tenantId: randomUUID(),
      product: input.product,
      status: 'TRIAL_ACTIVE',
      trialStartedAt,
      trialEndsAt,
      whatsappConnectedAt: null,
      restrictedAt: null,
      createdAt: trialStartedAt,
    });

    this.accounts.set(account.id, account);
    this.trialConsumedEmails.add(normalizedEmail);
    return { identity, account };
  }

  createPaidProductAccount(input: Omit<TrialRegistrationInput, 'product'> & { product: ProductKey }, now = new Date()): TrialRegistrationResult {
    const normalizedEmail = this.normalizeEmail(input.email);
    const identity = this.getOrCreateIdentity({ ...input, email: normalizedEmail }, now);
    const account = ProductAccountSchema.parse({
      id: randomUUID(),
      identityId: identity.id,
      tenantId: randomUUID(),
      product: input.product,
      status: 'ACTIVE',
      trialStartedAt: null,
      trialEndsAt: null,
      whatsappConnectedAt: null,
      restrictedAt: null,
      createdAt: now.toISOString(),
    });
    this.accounts.set(account.id, account);
    return { identity, account };
  }

  markWhatsAppConnected(accountId: string, now = new Date()): ProductAccount {
    return this.updateAccount(accountId, (account) => ({ ...account, whatsappConnectedAt: now.toISOString() }));
  }

  refreshLifecycle(now = new Date()): ProductAccount[] {
    const changed: ProductAccount[] = [];
    for (const account of this.accounts.values()) {
      if ((account.status === 'TRIAL_ACTIVE' || account.status === 'TRIAL_EXPIRING') && account.trialEndsAt) {
        const remainingMs = new Date(account.trialEndsAt).getTime() - now.getTime();
        const nextStatus: TrialStatus = remainingMs <= 0
          ? 'TRIAL_EXPIRED'
          : remainingMs <= 24 * 60 * 60 * 1000
            ? 'TRIAL_EXPIRING'
            : 'TRIAL_ACTIVE';
        if (nextStatus !== account.status) {
          const updated = { ...account, status: nextStatus };
          this.accounts.set(account.id, updated);
          changed.push(updated);
        }
      }
    }
    return changed;
  }

  restrictExpiredAccount(accountId: string, now = new Date()): ProductAccount {
    const account = this.requireAccount(accountId);
    if (account.status !== 'TRIAL_EXPIRED') throw new Error('only expired trial accounts can be restricted');
    const updated = { ...account, status: 'RESTRICTED' as const, restrictedAt: now.toISOString() };
    this.accounts.set(accountId, updated);
    return updated;
  }

  activateAfterPayment(accountId: string): ProductAccount {
    const account = this.requireAccount(accountId);
    if (account.status !== 'RESTRICTED' && account.status !== 'TRIAL_EXPIRED') {
      throw new Error('account is not awaiting reactivation');
    }
    const updated = { ...account, status: 'ACTIVE' as const, restrictedAt: null };
    this.accounts.set(accountId, updated);
    return updated;
  }

  getAccount(accountId: string): ProductAccount | undefined {
    return this.accounts.get(accountId);
  }

  listAccountsForEmail(email: string): ProductAccount[] {
    const identity = this.identitiesByEmail.get(this.normalizeEmail(email));
    if (!identity) return [];
    return [...this.accounts.values()].filter((account) => account.identityId === identity.id);
  }

  private getOrCreateIdentity(input: Omit<TrialRegistrationInput, 'product'>, now: Date): PlatformIdentity {
    const existing = this.identitiesByEmail.get(input.email);
    if (existing) return existing;
    const identity = PlatformIdentitySchema.parse({
      id: randomUUID(),
      fullName: input.fullName.trim(),
      email: input.email,
      phoneNumber: input.phoneNumber.trim(),
      createdAt: now.toISOString(),
    });
    this.identitiesByEmail.set(input.email, identity);
    return identity;
  }

  private requireAccount(accountId: string): ProductAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error('product account not found');
    return account;
  }

  private updateAccount(accountId: string, update: (account: ProductAccount) => ProductAccount): ProductAccount {
    const updated = update(this.requireAccount(accountId));
    const parsed = ProductAccountSchema.parse(updated);
    this.accounts.set(accountId, parsed);
    return parsed;
  }
}
