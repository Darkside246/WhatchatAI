import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppGroupRepository } from '../src/repositories/whatsappGroupRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('WhatsAppGroupRepository', () => {
  let businessId: string;
  let accountId: string;
  let groups: WhatsAppGroupRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    groups = new WhatsAppGroupRepository(pool);
  });

  it('preserves the group JID exactly as received', async () => {
    const group = await groups.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      groupJid: '120363012345678901@g.us',
      subject: 'Support Team',
    });

    expect(group.groupJid).toBe('120363012345678901@g.us');
    expect(group.subject).toBe('Support Team');
  });

  it('upserts the same group by JID rather than duplicating it', async () => {
    const first = await groups.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      groupJid: '120363012345678901@g.us',
      subject: 'Support Team',
      participantsCount: 5,
    });
    const second = await groups.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      groupJid: '120363012345678901@g.us',
      subject: 'Support Team (renamed)',
      participantsCount: 6,
    });

    expect(second.id).toBe(first.id);
    expect(second.subject).toBe('Support Team (renamed)');
    expect(second.participantsCount).toBe(6);
  });
});
