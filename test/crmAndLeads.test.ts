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

  describe('CrmContactRepository.listByBusiness (joined with the real WhatsApp contact identity)', () => {
    it('returns the real WhatsApp contact fields alongside the CRM profile', async () => {
      await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId, stage: 'new_enquiry' });

      const rows = await crmContacts.listByBusiness(businessId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.whatsappJid).toBe('15550004444@s.whatsapp.net');
      expect(rows[0]?.contactDisplayName).toBe('Prospective Customer');
      expect(rows[0]?.stage).toBe('new_enquiry');
    });

    it('never returns a soft-deleted CRM contact', async () => {
      const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });
      await pool.query('UPDATE crm_contacts SET deleted_at = now() WHERE id = $1', [crmContact.id]);

      const rows = await crmContacts.listByBusiness(businessId);
      expect(rows).toHaveLength(0);
    });
  });

  describe('CrmContactRepository.update (tenant-scoped)', () => {
    it('updates stage/leadStatus/notes/tags on a real, owned CRM contact', async () => {
      const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });

      const updated = await crmContacts.update(businessId, crmContact.id, {
        stage: 'qualified',
        leadStatus: 'open',
        notes: 'Called back, interested in the Growth plan.',
        tags: ['vip', 'follow-up'],
      });

      expect(updated?.stage).toBe('qualified');
      expect(updated?.leadStatus).toBe('open');
      expect(updated?.notes).toBe('Called back, interested in the Growth plan.');
      expect(updated?.tags).toEqual(['vip', 'follow-up']);
    });

    it('never updates a CRM contact belonging to a different business', async () => {
      const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });
      const otherBusinessId = await createTestBusiness('Other Business');

      const result = await crmContacts.update(otherBusinessId, crmContact.id, {
        stage: 'stolen',
        leadStatus: null,
        notes: null,
        tags: [],
      });
      expect(result).toBeNull();

      const untouched = await crmContacts.findById(crmContact.id);
      expect(untouched?.stage).toBeNull();
    });
  });

  describe('LeadRepository.listByBusiness / update (joined + tenant-scoped)', () => {
    it('returns the real WhatsApp contact fields alongside each lead', async () => {
      const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });
      await leads.create({ businessId, crmContactId: crmContact.id, source: 'whatsapp_inbound', score: 50 });

      const rows = await leads.listByBusiness(businessId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.whatsappJid).toBe('15550004444@s.whatsapp.net');
      expect(rows[0]?.contactDisplayName).toBe('Prospective Customer');
      expect(rows[0]?.status).toBe('NEW');
    });

    it('updates stage/score/value/nextAction/notes on a real, owned lead', async () => {
      const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });
      const lead = await leads.create({ businessId, crmContactId: crmContact.id });

      const updated = await leads.update(businessId, lead.id, {
        stage: 'pricing_sent',
        score: 88,
        value: 1500,
        nextAction: 'Follow up Thursday',
        notes: 'Asked about the annual discount.',
      });

      expect(updated?.stage).toBe('pricing_sent');
      expect(updated?.score).toBe(88);
      expect(updated?.value).toBe(1500);
      expect(updated?.nextAction).toBe('Follow up Thursday');
    });

    it('never updates a lead belonging to a different business', async () => {
      const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });
      const lead = await leads.create({ businessId, crmContactId: crmContact.id });
      const otherBusinessId = await createTestBusiness('Other Business');

      const result = await leads.update(otherBusinessId, lead.id, {
        stage: 'stolen',
        score: null,
        value: null,
        nextAction: null,
        notes: null,
      });
      expect(result).toBeNull();
    });

    it('updateStatusForBusiness transitions status only for the owning business', async () => {
      const crmContact = await crmContacts.upsertForWhatsAppContact({ businessId, whatsappContactId });
      const lead = await leads.create({ businessId, crmContactId: crmContact.id });
      const otherBusinessId = await createTestBusiness('Other Business');

      const deniedResult = await leads.updateStatusForBusiness(otherBusinessId, lead.id, 'WON');
      expect(deniedResult).toBeNull();

      const allowedResult = await leads.updateStatusForBusiness(businessId, lead.id, 'WON');
      expect(allowedResult?.status).toBe('WON');
    });
  });
});
