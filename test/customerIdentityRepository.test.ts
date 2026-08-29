import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { CustomerIdentityRepository } from '../src/repositories/customerIdentityRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('CustomerIdentityRepository', () => {
  let businessId: string;
  let repo: CustomerIdentityRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    repo = new CustomerIdentityRepository(pool);
  });

  it('getOrCreateForWhatsAppContact creates a new customer and links the identity on first sight', async () => {
    const customerId = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-1', 'Alex');

    const customer = await repo.findById(businessId, customerId);
    expect(customer).not.toBeNull();
    expect(customer!.displayName).toBe('Alex');

    const identities = await repo.listIdentitiesForCustomer(businessId, customerId);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      channel: 'whatsapp',
      identityType: 'whatsapp_contact_id',
      identityValue: 'contact-1',
      source: 'whatsapp_contact_link',
      confidence: 'high',
    });
  });

  it('getOrCreateForWhatsAppContact returns the same customer on repeated calls for the same contact', async () => {
    const first = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-1');
    const second = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-1');
    expect(second).toBe(first);

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM customers WHERE business_id = $1', [businessId]);
    expect(rows[0]!.count).toBe('1');
  });

  it('never fabricates a shared customer across two different contacts', async () => {
    const customerA = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-a');
    const customerB = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-b');
    expect(customerA).not.toBe(customerB);
  });

  it('enforces tenant isolation - the same identity value in two businesses resolves to two different customers', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const customerA = await repo.getOrCreateForWhatsAppContact(businessId, 'shared-contact-id');
    const customerB = await repo.getOrCreateForWhatsAppContact(otherBusinessId, 'shared-contact-id');
    expect(customerA).not.toBe(customerB);

    const foundInOther = await repo.findCustomerIdByIdentity(otherBusinessId, 'whatsapp', 'whatsapp_contact_id', 'shared-contact-id');
    expect(foundInOther).toBe(customerB);
    const foundInOwn = await repo.findCustomerIdByIdentity(businessId, 'whatsapp', 'whatsapp_contact_id', 'shared-contact-id');
    expect(foundInOwn).toBe(customerA);
  });

  it('linkIdentity refreshes source/confidence on the same identity rather than duplicating rows', async () => {
    const customerId = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-1');
    const updated = await repo.linkIdentity({
      businessId,
      customerId,
      channel: 'whatsapp',
      identityType: 'whatsapp_contact_id',
      identityValue: 'contact-1',
      source: 'verified',
      confidence: 'high',
    });
    expect(updated.source).toBe('verified');

    const identities = await repo.listIdentitiesForCustomer(businessId, customerId);
    expect(identities).toHaveLength(1);
  });

  it('findCustomerIdByIdentity returns null for an identity that was never linked', async () => {
    const result = await repo.findCustomerIdByIdentity(businessId, 'whatsapp', 'whatsapp_contact_id', 'never-seen');
    expect(result).toBeNull();
  });

  it('findById returns null for a customer id from a different business', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const customerId = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-1');
    const result = await repo.findById(otherBusinessId, customerId);
    expect(result).toBeNull();
  });

  it('supports linking a second, distinct channel identity to an already-existing customer', async () => {
    const customerId = await repo.getOrCreateForWhatsAppContact(businessId, 'contact-1');
    await repo.linkIdentity({
      businessId,
      customerId,
      channel: 'email',
      identityType: 'email_address',
      identityValue: 'alex@example.com',
      source: 'crm_link',
      confidence: 'medium',
    });

    const identities = await repo.listIdentitiesForCustomer(businessId, customerId);
    expect(identities).toHaveLength(2);
    expect(identities.map((identity) => identity.channel).sort()).toEqual(['email', 'whatsapp']);
  });
});
