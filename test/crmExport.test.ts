import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { LeadRepository } from '../src/repositories/leadRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const crmContactRepo = new CrmContactRepository(pool);
const leadRepo = new LeadRepository(pool);
const waContactRepo = new WhatsAppContactRepository(pool);

describe('workspaceService.exportCrmData (Section 67 - real Postgres)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('returns real, empty arrays when there is nothing to export', async () => {
    const { contacts, leads } = await workspaceService.exportCrmData(businessId);
    expect(contacts).toEqual([]);
    expect(leads).toEqual([]);
  });

  it('exports a real contact with its real WhatsApp name resolved', async () => {
    const waContact = await waContactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15550001111@s.whatsapp.net', jidKind: 'individual', displayName: 'Export Test Contact', phoneNumber: '+15550001111' });
    await crmContactRepo.upsertForWhatsAppContact({ businessId, whatsappContactId: waContact.id });

    const { contacts } = await workspaceService.exportCrmData(businessId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.contactDisplayName).toBe('Export Test Contact');
    expect(contacts[0]?.phoneNumber).toBe('+15550001111');
  });

  it('excludes a contact hidden by the business\'s own privacy settings - export must never override that', async () => {
    const waContact = await waContactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15550002222@s.whatsapp.net', jidKind: 'individual', displayName: 'Hidden Contact' });
    const crmContact = await crmContactRepo.upsertForWhatsAppContact({ businessId, whatsappContactId: waContact.id });
    await crmContactRepo.setPrivacyFlags(businessId, crmContact.id, { isHidden: true });

    const { contacts } = await workspaceService.exportCrmData(businessId);
    expect(contacts).toEqual([]);
  });

  it('exports a real lead with its real contact name joined in', async () => {
    const waContact = await waContactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15550003333@s.whatsapp.net', jidKind: 'individual', displayName: 'Lead Contact' });
    const crmContact = await crmContactRepo.upsertForWhatsAppContact({ businessId, whatsappContactId: waContact.id });
    await leadRepo.create({ businessId, crmContactId: crmContact.id, source: 'whatsapp', stage: 'qualified' });

    const { leads } = await workspaceService.exportCrmData(businessId);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.contactDisplayName).toBe('Lead Contact');
    expect(leads[0]?.stage).toBe('qualified');
  });

  it('never leaks another business\'s contacts or leads into this business\'s export', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAccountId = await createTestAccount(otherBusinessId, '15550004444@s.whatsapp.net');
    const otherWaContact = await waContactRepo.upsertFromWhatsApp({ businessId: otherBusinessId, whatsappAccountId: otherAccountId, whatsappJid: '15550004444@s.whatsapp.net', jidKind: 'individual', displayName: 'Other Business Contact' });
    await crmContactRepo.upsertForWhatsAppContact({ businessId: otherBusinessId, whatsappContactId: otherWaContact.id });

    const { contacts } = await workspaceService.exportCrmData(businessId);
    expect(contacts).toEqual([]);
  });
});
