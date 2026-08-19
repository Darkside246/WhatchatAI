import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('WhatsAppContactRepository', () => {
  let businessId: string;
  let accountId: string;
  let contacts: WhatsAppContactRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    contacts = new WhatsAppContactRepository(pool);
  });

  it('creates a contact from real WhatsApp data', async () => {
    const contact = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550002222',
      pushName: 'Jane',
    });

    expect(contact.id).toBeTruthy();
    expect(contact.whatsappJid).toBe('15550002222@s.whatsapp.net');
    expect(contact.phoneNumber).toBe('+15550002222');
    expect(contact.pushName).toBe('Jane');
  });

  it('upserts by JID instead of creating a duplicate row', async () => {
    const first = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      pushName: 'Jane',
    });
    const second = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      pushName: 'Jane',
    });

    expect(second.id).toBe(first.id);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM whatsapp_contacts WHERE whatsapp_jid = $1', [
      '15550002222@s.whatsapp.net',
    ]);
    expect(rows[0].count).toBe(1);
  });

  it('updates the existing contact in place when the display name changes (never creates a new person)', async () => {
    const first = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '12462451422@s.whatsapp.net',
      jidKind: 'individual',
      displayName: 'John',
    });
    const renamed = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '12462451422@s.whatsapp.net',
      jidKind: 'individual',
      displayName: 'John Smith',
    });

    expect(renamed.id).toBe(first.id);
    expect(renamed.displayName).toBe('John Smith');
  });

  it('preserves a @lid JID exactly, with phone_number NULL when no mapping is available', async () => {
    const contact = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '234471341175024@lid',
      jidKind: 'lid',
      phoneNumber: null,
    });

    expect(contact.whatsappJid).toBe('234471341175024@lid');
    expect(contact.jidKind).toBe('lid');
    expect(contact.phoneNumber).toBeNull();
  });

  it('preserves a phone-based JID exactly', async () => {
    const contact = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '447700900123@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+447700900123',
    });

    expect(contact.whatsappJid).toBe('447700900123@s.whatsapp.net');
    expect(contact.phoneNumber).toBe('+447700900123');
  });
});
