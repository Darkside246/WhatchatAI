import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  submitCampaignForReview,
  approveCampaign,
  sendCampaign,
  cancelCampaign,
  listEligibleCampaignRecipients,
  isInvalidCampaignStatusError,
  isNoEligibleRecipientsError,
  isTooManyRecipientsError,
  isCampaignNotFoundError,
} from '../src/services/campaignService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };
const crmContactRepository = new CrmContactRepository(pool);

async function makeEligibleContact(businessId: string, accountId: string, jid: string, name: string) {
  const contactRepo = new WhatsAppContactRepository(pool);
  const chatRepo = new WhatsAppChatRepository(pool);
  const contact = await contactRepo.upsertFromWhatsApp({
    businessId,
    whatsappAccountId: accountId,
    whatsappJid: jid,
    jidKind: 'individual',
    phoneNumber: `+${jid.split('@')[0]}`,
    pushName: name,
  });
  await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: jid, jidKind: 'individual', chatType: 'individual', contactId: contact.id });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source) VALUES ($1, $2, 'whatsapp_inbound') RETURNING id`,
    [businessId, contact.id],
  );
  return rows[0]!.id;
}

describe('campaignService (real eligibility, real status machine, real send pipeline)', () => {
  let businessId: string;
  let accountId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
    accountId = await createTestAccount(businessId);
  });

  it('listEligibleCampaignRecipients only returns contacts with a real existing conversation, never cold-outreach targets', async () => {
    const eligibleId = await makeEligibleContact(businessId, accountId, '15559990001@s.whatsapp.net', 'Real Prospect');

    // A crm_contact with a WhatsApp identity but NO chat (never messaged) - must never be eligible.
    const contactRepo = new WhatsAppContactRepository(pool);
    const noChatContact = await contactRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15559990002@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15559990002',
      pushName: 'Never Messaged',
    });
    await pool.query(`INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source) VALUES ($1, $2, 'manual')`, [businessId, noChatContact.id]);

    const eligible = await listEligibleCampaignRecipients(businessId, accountId);
    expect(eligible.map((r) => r.crmContactId)).toEqual([eligibleId]);
  });

  it('excludes an opted-out contact from eligibility', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990003@s.whatsapp.net', 'Opted Out');
    await crmContactRepository.setOptedOut(businessId, contactId, true);

    const eligible = await listEligibleCampaignRecipients(businessId, accountId);
    expect(eligible.map((r) => r.crmContactId)).not.toContain(contactId);
  });

  it('creates a real DRAFT campaign, silently reporting (never force-adding) any requested id that was not eligible', async () => {
    const eligibleId = await makeEligibleContact(businessId, accountId, '15559990004@s.whatsapp.net', 'Eligible');
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const result = await createCampaign(businessId, accountId, ownerId, {
      name: 'Spring Promo',
      messageText: 'Hello!',
      crmContactIds: [eligibleId, fakeId],
    });

    expect(result.campaign.status).toBe('DRAFT');
    expect(result.requestedCount).toBe(2);
    expect(result.addedCount).toBe(1);
    expect(result.skippedCrmContactIds).toEqual([fakeId]);

    const detail = await getCampaign(businessId, result.campaign.id);
    expect(detail.recipients).toHaveLength(1);
    expect(detail.recipients[0]?.crmContactId).toBe(eligibleId);
  });

  it('rejects a campaign where none of the requested contacts are eligible', async () => {
    await expect(createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: ['00000000-0000-0000-0000-000000000000'] })).rejects.toThrow();
    try {
      await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: ['00000000-0000-0000-0000-000000000000'] });
    } catch (error) {
      expect(isNoEligibleRecipientsError(error)).toBe(true);
    }
  });

  it('rejects a campaign requesting more recipients than the safety cap', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    await expect(createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: tooMany })).rejects.toThrow();
    try {
      await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: tooMany });
    } catch (error) {
      expect(isTooManyRecipientsError(error)).toBe(true);
    }
  });

  it('enforces the real status state machine: cannot approve a DRAFT, cannot send an unapproved campaign', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990005@s.whatsapp.net', 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: [contactId] });

    await expect(approveCampaign(businessId, campaign.id, ownerId)).rejects.toThrow();
    await expect(sendCampaign(businessId, campaign.id)).rejects.toThrow();
    try {
      await approveCampaign(businessId, campaign.id, ownerId);
    } catch (error) {
      expect(isInvalidCampaignStatusError(error)).toBe(true);
    }

    await submitCampaignForReview(businessId, campaign.id);
    const approved = await approveCampaign(businessId, campaign.id, ownerId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe(ownerId);
  });

  it('sending an approved campaign dispatches a real outbound message per recipient and flips to RUNNING', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990006@s.whatsapp.net', 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'Hello there', crmContactIds: [contactId] });
    await submitCampaignForReview(businessId, campaign.id);
    await approveCampaign(businessId, campaign.id, ownerId);

    const sent = await sendCampaign(businessId, campaign.id);
    expect(sent.status).toBe('RUNNING');
    expect(sent.sentAt).not.toBeNull();

    const detail = await getCampaign(businessId, campaign.id);
    expect(detail.recipients[0]?.outboundMessageId).not.toBeNull();
    // A real outbound row was actually created and queued - never fabricated.
    expect(detail.counts.total).toBe(1);
  });

  it('cancel works before send, but is refused once a campaign has already started running', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990007@s.whatsapp.net', 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: [contactId] });
    const cancelled = await cancelCampaign(businessId, campaign.id);
    expect(cancelled.status).toBe('CANCELLED');

    const { campaign: second } = await createCampaign(businessId, accountId, ownerId, { name: 'x2', messageText: 'y', crmContactIds: [contactId] });
    await submitCampaignForReview(businessId, second.id);
    await approveCampaign(businessId, second.id, ownerId);
    await sendCampaign(businessId, second.id);
    await expect(cancelCampaign(businessId, second.id)).rejects.toThrow();
  });

  it('refuses to touch a campaign belonging to a different business', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990008@s.whatsapp.net', 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: [contactId] });
    const otherBusinessId = await createTestBusiness('Other Business');

    await expect(getCampaign(otherBusinessId, campaign.id)).rejects.toThrow();
    try {
      await getCampaign(otherBusinessId, campaign.id);
    } catch (error) {
      expect(isCampaignNotFoundError(error)).toBe(true);
    }

    const campaigns = await listCampaigns(businessId);
    expect(campaigns.map((c) => c.id)).toContain(campaign.id);
    expect(await listCampaigns(otherBusinessId)).toHaveLength(0);
  });
});
