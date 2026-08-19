import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('Tenant isolation', () => {
  let businessA: string;
  let businessB: string;
  let accountA: string;
  let accountB: string;
  let contacts: WhatsAppContactRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessA = await createTestBusiness('Business A');
    businessB = await createTestBusiness('Business B');
    accountA = await createTestAccount(businessA, '15550001111@s.whatsapp.net');
    accountB = await createTestAccount(businessB, '15550009999@s.whatsapp.net');
    contacts = new WhatsAppContactRepository(pool);
  });

  it('the same real WhatsApp JID under two different businesses creates two isolated contact rows', async () => {
    const contactA = await contacts.upsertFromWhatsApp({
      businessId: businessA,
      whatsappAccountId: accountA,
      whatsappJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      displayName: 'Shared Number (seen by Business A)',
    });
    const contactB = await contacts.upsertFromWhatsApp({
      businessId: businessB,
      whatsappAccountId: accountB,
      whatsappJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      displayName: 'Shared Number (seen by Business B)',
    });

    expect(contactA.id).not.toBe(contactB.id);

    const businessAContacts = await contacts.search(businessA, accountA, '15550002222');
    expect(businessAContacts).toHaveLength(1);
    expect(businessAContacts[0].id).toBe(contactA.id);

    const businessBContacts = await contacts.search(businessB, accountB, '15550002222');
    expect(businessBContacts).toHaveLength(1);
    expect(businessBContacts[0].id).toBe(contactB.id);
  });

  it("business A cannot find business B's contact by id lookup scoped to its own tenant", async () => {
    const contactB = await contacts.upsertFromWhatsApp({
      businessId: businessB,
      whatsappAccountId: accountB,
      whatsappJid: '15550003333@s.whatsapp.net',
      jidKind: 'individual',
    });

    const foundUnderWrongTenant = await contacts.findByJid(businessA, accountA, contactB.whatsappJid);
    expect(foundUnderWrongTenant).toBeNull();
  });
});
