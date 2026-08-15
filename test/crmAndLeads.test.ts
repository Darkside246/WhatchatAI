import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { LeadRepository } from '../src/repositories/leadRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('CRM contacts and leads', () => {
  let businessId: string;
  let accountId: string;
  let whatsappContactId: string;
  let crmContacts: CrmContactRepository;
  let leads: LeadRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const contactRepo = new WhatsAppContactRepository(pool);
    const contact = await contactRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      displayName: 'Prospective Customer',
    });
    whatsappContactId = contact.id;

    crmContacts = new CrmContactRepository(pool);
    leads = new LeadRepository(pool);
  });

  it('builds a CRM profile around a real WhatsApp contact identity', async () => {
    const crmContact = await crmContacts.upsertForWhatsAppContact({
      businessId,
      whatsappContactId,
      source: 'whatsapp_inbound',
      stage: 'new_enquiry',
    });

    expect(crmContact.whatsappContactId).toBe(whatsappContactId);
    expect(crmContact.source).toBe('whatsapp_inbound');
  });

  it('never creates a duplicate CRM profile for the same WhatsApp contact', async () => {
    const first = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId, stage: 'new_enquiry' });
    const second = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId, stage: 'qualified' });

    expect(second.id).toBe(first.id);
    expect(second.stage).toBe('qualified');
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM crm_contacts WHERE whatsapp_contact_id = $1', [
      whatsappContactId,
    ]);
    expect(rows[0].count).toBe(1);
  });

  it('creates a real lead attached to the CRM contact and tracks its status', async () => {
    const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });
    const lead = await leads.create({
      businessId,
      crmContactId: crmContact.id,
      source: 'whatsapp_inbound',
      stage: 'pricing_request',
      score: 72,
    });

    expect(lead.status).toBe('NEW');
    expect(lead.score).toBe(72);

    await leads.updateStatus(lead.id, 'QUALIFIED');
    const list = await leads.listByCrmContact(crmContact.id);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('QUALIFIED');
  });

  it('a lead can never be created without a real, already-persisted CRM contact (FK-enforced)', async () => {
    await expect(
      leads.create({ businessId, crmContactId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow();
  });
});
