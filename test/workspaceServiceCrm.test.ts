import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { workspaceService, isCrmContactNotFoundError, isLeadNotFoundError } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('workspaceService CRM & Leads (real display-name resolution + tenant isolation)', () => {
  let businessId: string;
  let accountId: string;
  let whatsappContactId: string;
  let crmContactId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const contactRepo = new WhatsAppContactRepository(pool);
    const contact = await contactRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550007777@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550007777',
      pushName: 'Real Prospect',
    });
    whatsappContactId = contact.id;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source, stage)
       VALUES ($1, $2, 'whatsapp_inbound', 'new_enquiry') RETURNING id`,
      [businessId, whatsappContactId],
    );
    crmContactId = rows[0]!.id;
  });

  describe('listCrmContacts', () => {
    it('resolves a real display name from the linked WhatsApp contact, never fabricating one', async () => {
      const contacts = await workspaceService.listCrmContacts(businessId);
      expect(contacts).toHaveLength(1);
      expect(contacts[0]?.displayName).toBe('Real Prospect');
      expect(contacts[0]?.stage).toBe('new_enquiry');
    });

    it('never returns another business\' CRM contacts', async () => {
      const otherBusinessId = await createTestBusiness('Other Business');
      const contacts = await workspaceService.listCrmContacts(otherBusinessId);
      expect(contacts).toEqual([]);
    });

    it('Section 66: surfaces the real underlying name-source breakdown, not just the collapsed display name', async () => {
      const contactRepo = new WhatsAppContactRepository(pool);
      await contactRepo.upsertFromWhatsApp({
        businessId,
        whatsappAccountId: accountId,
        whatsappJid: '15550008888@s.whatsapp.net',
        jidKind: 'individual',
        phoneNumber: '+15550008888',
        pushName: 'Johnny',
        verifiedName: 'John Smith',
        businessName: 'Smith Contracting',
        shortName: 'John',
      });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source) VALUES ($1, (SELECT id FROM whatsapp_contacts WHERE whatsapp_jid = '15550008888@s.whatsapp.net' AND business_id = $1), 'whatsapp_inbound') RETURNING id`,
        [businessId],
      );
      expect(rows[0]?.id).toBeTruthy();

      const contacts = await workspaceService.listCrmContacts(businessId);
      const richContact = contacts.find((c) => c.pushName === 'Johnny');
      expect(richContact?.verifiedName).toBe('John Smith');
      expect(richContact?.businessName).toBe('Smith Contracting');
      expect(richContact?.shortName).toBe('John');
      // The original fixture contact only ever had a push name - every
      // other source must stay honestly null, never fabricated.
      const sparseContact = contacts.find((c) => c.pushName === 'Real Prospect');
      expect(sparseContact?.verifiedName).toBeNull();
      expect(sparseContact?.businessName).toBeNull();
      expect(sparseContact?.shortName).toBeNull();
    });
  });

  describe('updateCrmContact', () => {
    it('persists the update and returns it with the real display name intact', async () => {
      const updated = await workspaceService.updateCrmContact(businessId, crmContactId, {
        stage: 'qualified',
        leadStatus: 'open',
        notes: 'Real note',
        tags: ['vip'],
      });

      expect(updated.stage).toBe('qualified');
      expect(updated.displayName).toBe('Real Prospect');
    });

    it('rejects an update against a CRM contact from a different business - never a cross-tenant write', async () => {
      const otherBusinessId = await createTestBusiness('Other Business');

      await expect(
        workspaceService.updateCrmContact(otherBusinessId, crmContactId, {
          stage: 'stolen',
          leadStatus: null,
          notes: null,
          tags: [],
        }),
      ).rejects.toSatisfy((error: unknown) => isCrmContactNotFoundError(error));
    });
  });

  describe('createLead / listLeads / updateLead / updateLeadStatus', () => {
    it('creates a real lead tied to a genuinely owned CRM contact', async () => {
      const lead = await workspaceService.createLead(businessId, { crmContactId, source: 'whatsapp_inbound' });
      expect(lead.status).toBe('NEW');

      const leads = await workspaceService.listLeads(businessId);
      expect(leads).toHaveLength(1);
      expect(leads[0]?.displayName).toBe('Real Prospect');
    });

    it('refuses to create a lead against a CRM contact from a different business', async () => {
      const otherBusinessId = await createTestBusiness('Other Business');

      await expect(
        workspaceService.createLead(otherBusinessId, { crmContactId }),
      ).rejects.toSatisfy((error: unknown) => isCrmContactNotFoundError(error));
    });

    it('updateLead and updateLeadStatus are tenant-scoped', async () => {
      const lead = await workspaceService.createLead(businessId, { crmContactId });
      const otherBusinessId = await createTestBusiness('Other Business');

      await expect(
        workspaceService.updateLead(otherBusinessId, lead.id, {
          stage: 'stolen',
          score: null,
          value: null,
          nextAction: null,
          notes: null,
        }),
      ).rejects.toSatisfy((error: unknown) => isLeadNotFoundError(error));

      await expect(workspaceService.updateLeadStatus(otherBusinessId, lead.id, 'WON')).rejects.toSatisfy(
        (error: unknown) => isLeadNotFoundError(error),
      );

      const updated = await workspaceService.updateLeadStatus(businessId, lead.id, 'WON');
      expect(updated.status).toBe('WON');
    });
  });
});
