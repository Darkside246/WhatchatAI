import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import {
  createCampaign,
  updateDraftCampaign,
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
import { whatsappOutboundMessageService } from '../src/services/whatsappOutboundMessageService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import { isEntitlementDeniedError } from '../src/services/workspaceService.js';
import { WhatsAppOutboundMessageRepository } from '../src/repositories/whatsappOutboundMessageRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { processMessageStatus } from '../src/queue/workers/incomingMessagesWorker.js';

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

  it('enforces the real per-plan max_active_campaigns entitlement - a new business defaults to the Starter plan (limit 1)', async () => {
    const first = await makeEligibleContact(businessId, accountId, '15559990010@s.whatsapp.net', 'First');
    await createCampaign(businessId, accountId, ownerId, { name: 'Campaign 1', messageText: 'Hi', crmContactIds: [first] });

    const second = await makeEligibleContact(businessId, accountId, '15559990011@s.whatsapp.net', 'Second');
    await expect(
      createCampaign(businessId, accountId, ownerId, { name: 'Campaign 2', messageText: 'Hi', crmContactIds: [second] }),
    ).rejects.toThrow();
    try {
      await createCampaign(businessId, accountId, ownerId, { name: 'Campaign 2', messageText: 'Hi', crmContactIds: [second] });
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) expect(error.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
    }
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

  describe('Section 27-30: real attachments, reusing the exact pipeline the 1:1 composer already uses', () => {
    // A real, minimal 1x1 transparent PNG - small enough to keep these tests fast, real enough to exercise storeMedia()'s actual decode/hash/store path.
    const onePixelPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    it('stores a real attachment once at creation and returns it on the campaign', async () => {
      const contactId = await makeEligibleContact(businessId, accountId, '15559990020@s.whatsapp.net', 'Contact');
      const { campaign } = await createCampaign(businessId, accountId, ownerId, {
        name: 'Photo Promo',
        messageText: 'Check out our new menu!',
        crmContactIds: [contactId],
        attachment: { messageType: 'image', mediaBase64: onePixelPngBase64, mediaMimeType: 'image/png', mediaFileName: 'menu.png' },
      });

      expect(campaign.messageType).toBe('image');
      expect(campaign.mediaStorageReference).toBeTruthy();
      expect(campaign.mediaMimeType).toBe('image/png');
      expect(campaign.mediaFileName).toBe('menu.png');
    });

    it('defaults to a text-only campaign when no attachment is given, unchanged from before this feature existed', async () => {
      const contactId = await makeEligibleContact(businessId, accountId, '15559990021@s.whatsapp.net', 'Contact');
      const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'Text Only', messageText: 'Hi', crmContactIds: [contactId] });

      expect(campaign.messageType).toBe('text');
      expect(campaign.mediaStorageReference).toBeNull();
    });

    it('sends the real stored attachment to every recipient - the send call itself never re-encodes fresh base64', async () => {
      const contactId = await makeEligibleContact(businessId, accountId, '15559990022@s.whatsapp.net', 'Contact');
      const { campaign } = await createCampaign(businessId, accountId, ownerId, {
        name: 'Photo Promo 2',
        messageText: 'New arrivals!',
        crmContactIds: [contactId],
        attachment: { messageType: 'image', mediaBase64: onePixelPngBase64, mediaMimeType: 'image/png', mediaFileName: 'arrivals.png' },
      });
      await submitCampaignForReview(businessId, campaign.id);
      await approveCampaign(businessId, campaign.id, ownerId);

      const sendSpy = vi.spyOn(whatsappOutboundMessageService, 'send');
      await sendCampaign(businessId, campaign.id);

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: 'image',
          caption: 'New arrivals!',
          mediaStorageReference: campaign.mediaStorageReference,
          mediaMimeType: 'image/png',
          mediaFileName: 'arrivals.png',
        }),
      );
      expect(sendSpy.mock.calls[0]?.[0]).not.toHaveProperty('mediaBase64');
      sendSpy.mockRestore();

      const outbound = new WhatsAppOutboundMessageRepository(pool);
      const detail = await getCampaign(businessId, campaign.id);
      const record = await outbound.findByIdForBusiness(detail.recipients[0]!.outboundMessageId!, businessId);
      expect(record?.messageType).toBe('image');
      expect(record?.mediaStorageReference).toBe(campaign.mediaStorageReference);
    });

    it('a draft can have an attachment added later, via updateDraftCampaign', async () => {
      const contactId = await makeEligibleContact(businessId, accountId, '15559990023@s.whatsapp.net', 'Contact');
      const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: [contactId] });
      expect(campaign.messageType).toBe('text');

      const updated = await updateDraftCampaign(businessId, campaign.id, {
        name: 'x',
        messageText: 'y',
        attachment: { messageType: 'document', mediaBase64: onePixelPngBase64, mediaMimeType: 'application/pdf', mediaFileName: 'flyer.pdf' },
      });

      expect(updated.messageType).toBe('document');
      expect(updated.mediaStorageReference).toBeTruthy();
      expect(updated.mediaFileName).toBe('flyer.pdf');
    });

    it('removeAttachment reverts a draft back to text-only', async () => {
      const contactId = await makeEligibleContact(businessId, accountId, '15559990024@s.whatsapp.net', 'Contact');
      const { campaign } = await createCampaign(businessId, accountId, ownerId, {
        name: 'x',
        messageText: 'y',
        crmContactIds: [contactId],
        attachment: { messageType: 'image', mediaBase64: onePixelPngBase64, mediaMimeType: 'image/png' },
      });
      expect(campaign.messageType).toBe('image');

      const updated = await updateDraftCampaign(businessId, campaign.id, { name: 'x', messageText: 'y', removeAttachment: true });

      expect(updated.messageType).toBe('text');
      expect(updated.mediaStorageReference).toBeNull();
      expect(updated.mediaMimeType).toBeNull();
    });

    it('never leaves a partially-created campaign behind when the attachment itself is invalid (empty decoded bytes)', async () => {
      const contactId = await makeEligibleContact(businessId, accountId, '15559990025@s.whatsapp.net', 'Contact');
      await expect(
        createCampaign(businessId, accountId, ownerId, {
          name: 'Bad Attachment',
          messageText: 'y',
          crmContactIds: [contactId],
          attachment: { messageType: 'image', mediaBase64: '', mediaMimeType: 'image/png' },
        }),
      ).rejects.toThrow();

      const campaigns = await listCampaigns(businessId);
      expect(campaigns.find((c) => c.name === 'Bad Attachment')).toBeUndefined();
    });
  });

  it('Section 26: recipient status genuinely reaches delivered and read as real WhatsApp acks arrive - counts are live-computed, never stuck at 0', async () => {
    const chatJid = '15559990010@s.whatsapp.net';
    const contactId = await makeEligibleContact(businessId, accountId, chatJid, 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'Delivery Test', messageText: 'Hello there', crmContactIds: [contactId] });
    await submitCampaignForReview(businessId, campaign.id);
    await approveCampaign(businessId, campaign.id, ownerId);
    await sendCampaign(businessId, campaign.id);

    const beforeAck = await getCampaign(businessId, campaign.id);
    expect(beforeAck.counts.delivered).toBe(0);
    expect(beforeAck.counts.read).toBe(0);
    const recipient = beforeAck.recipients[0];
    const outboundMessageId = recipient?.outboundMessageId;
    expect(outboundMessageId).toBeTruthy();

    // Simulate what really happens next, end to end, using the real
    // production code paths rather than reimplementing them:
    // 1. The real send actually reaches WhatsApp - markSent records the
    //    real WhatsApp message id the send call returned.
    const whatsappMessageId = 'WAMSG-DELIVERY-TEST-1';
    await new WhatsAppOutboundMessageRepository(pool).markSent(outboundMessageId as string, whatsappMessageId);

    // 2. Baileys echoes our own sent message back through the normal
    //    messages.upsert path (fromMe: true) - this is what actually
    //    creates the whatsapp_messages row in production.
    const messageRepo = new WhatsAppMessageRepository(pool);
    const persisted = await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: recipient!.chatId,
      whatsappMessageId,
      remoteJid: chatJid,
      senderJid: '15550001111@s.whatsapp.net',
      direction: 'outbound',
      messageType: 'text',
      textContent: 'Hello there',
      timestamp: new Date().toISOString(),
      fromMe: true,
      isHistorical: false,
    });

    // 3. incomingMessagesWorker links the echoed message back to the send
    //    request that triggered it (real linkPersistedMessage call).
    await new WhatsAppOutboundMessageRepository(pool).linkPersistedMessage(accountId, whatsappMessageId, persisted.id);

    const afterLink = await getCampaign(businessId, campaign.id);
    expect(afterLink.counts.sent).toBe(1);
    expect(afterLink.counts.delivered).toBe(0);

    // 4. A real delivery ack arrives from WhatsApp - processMessageStatus
    //    is the exact real handler a live socket event dispatches to.
    await processMessageStatus({ businessId, whatsappAccountId: accountId, whatsappMessageId, status: 'delivered' });

    const afterDelivered = await getCampaign(businessId, campaign.id);
    expect(afterDelivered.counts.delivered).toBe(1);
    expect(afterDelivered.counts.sent).toBe(0); // delivered supersedes sent, never double-counted
    expect(afterDelivered.recipients[0]?.status).toBe('delivered');

    // 5. A later real read ack arrives.
    await processMessageStatus({ businessId, whatsappAccountId: accountId, whatsappMessageId, status: 'read' });

    const afterRead = await getCampaign(businessId, campaign.id);
    expect(afterRead.counts.read).toBe(1);
    expect(afterRead.counts.delivered).toBe(0);
    expect(afterRead.recipients[0]?.status).toBe('read');
  });

  it('cancel works before send', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990007@s.whatsapp.net', 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x', messageText: 'y', crmContactIds: [contactId] });
    const cancelled = await cancelCampaign(businessId, campaign.id);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('is refused once a campaign has already reached a real terminal state', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990007@s.whatsapp.net', 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x2', messageText: 'y', crmContactIds: [contactId] });
    await submitCampaignForReview(businessId, campaign.id);
    await approveCampaign(businessId, campaign.id, ownerId);
    await cancelCampaign(businessId, campaign.id);
    await expect(cancelCampaign(businessId, campaign.id)).rejects.toThrow(); // already CANCELLED
  });

  it('Section 49 (emergency stop): cancelling a RUNNING campaign stops every recipient still queued, without touching one already sent', async () => {
    const stillQueued = await makeEligibleContact(businessId, accountId, '15559990010@s.whatsapp.net', 'Still Queued');
    const alreadySent = await makeEligibleContact(businessId, accountId, '15559990011@s.whatsapp.net', 'Already Sent');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, {
      name: 'Mistake spotted mid-send',
      messageText: 'Oops, wrong price',
      crmContactIds: [alreadySent, stillQueued],
    });
    await submitCampaignForReview(businessId, campaign.id);
    await approveCampaign(businessId, campaign.id, ownerId);
    await sendCampaign(businessId, campaign.id);

    const beforeCancel = await getCampaign(businessId, campaign.id);
    const sentRecipient = beforeCancel.recipients.find((r) => r.crmContactId === alreadySent);
    expect(sentRecipient?.outboundMessageId).toBeTruthy();
    // Real production behaviour: the row genuinely sat in a real outbound
    // pipeline with no live WhatsApp connection to dispatch to in this test
    // environment, so it is still 'queued' - exactly the window the fix
    // targets. Simulate the one recipient that a live socket had already
    // gotten to before the operator noticed the mistake and clicked stop.
    const outboundRepo = new WhatsAppOutboundMessageRepository(pool);
    await pool.query(`UPDATE whatsapp_outbound_messages SET status = 'sent', sent_at = now() WHERE id = $1`, [sentRecipient!.outboundMessageId]);

    const cancelled = await cancelCampaign(businessId, campaign.id);
    expect(cancelled.status).toBe('CANCELLED');

    const afterCancel = await getCampaign(businessId, campaign.id);
    expect(afterCancel.recipients.find((r) => r.crmContactId === stillQueued)?.status).toBe('cancelled');
    expect(afterCancel.recipients.find((r) => r.crmContactId === alreadySent)?.status).toBe('sent');
    expect(afterCancel.counts.cancelled).toBe(1);
    expect(afterCancel.counts.queued).toBe(0);

    const stillQueuedRow = await outboundRepo.findById(afterCancel.recipients.find((r) => r.crmContactId === stillQueued)!.outboundMessageId!);
    expect(stillQueuedRow?.status).toBe('cancelled');
  });

  it('cancelling a RUNNING campaign twice is safe - the second call finds nothing left queued to stop', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990012@s.whatsapp.net', 'Contact');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'x3', messageText: 'y', crmContactIds: [contactId] });
    await submitCampaignForReview(businessId, campaign.id);
    await approveCampaign(businessId, campaign.id, ownerId);
    await sendCampaign(businessId, campaign.id);

    await cancelCampaign(businessId, campaign.id);
    await expect(cancelCampaign(businessId, campaign.id)).rejects.toThrow(); // already CANCELLED, a real terminal state
  });

  it('a recipient whose dispatch throws (e.g. their chat vanished) reaches an honest FAILED state, never stuck as "queued" forever, and the business is notified', async () => {
    const contactId = await makeEligibleContact(businessId, accountId, '15559990009@s.whatsapp.net', 'Vanishing');
    const { campaign } = await createCampaign(businessId, accountId, ownerId, { name: 'Doomed Send', messageText: 'Hi', crmContactIds: [contactId] });
    await submitCampaignForReview(businessId, campaign.id);
    await approveCampaign(businessId, campaign.id, ownerId);

    // Simulate the real failure mode whatsappOutboundMessageService.send()
    // itself throws for (e.g. ChatNotFoundError when the recipient's chat
    // vanished between recipient-list creation and send time) - before any
    // outbound_message row is ever created.
    const sendSpy = vi.spyOn(whatsappOutboundMessageService, 'send').mockRejectedValueOnce(new Error('Chat not found for this business.'));

    await sendCampaign(businessId, campaign.id);
    sendSpy.mockRestore();

    const detail = await getCampaign(businessId, campaign.id);
    expect(detail.recipients[0]?.outboundMessageId).toBeNull();
    expect(detail.recipients[0]?.status).toBe('failed');
    expect(detail.counts.failed).toBe(1);
    expect(detail.counts.queued).toBe(0);

    // With no real recipients left queued, the campaign reaches a real
    // terminal status on the next read instead of staying RUNNING forever.
    expect(detail.campaign.status).toBe('COMPLETED');

    const { rows: notificationRows } = await pool.query<{ type: string }>(
      `SELECT type FROM notifications WHERE business_id = $1 AND target_id = $2`,
      [businessId, campaign.id],
    );
    expect(notificationRows.some((row) => row.type === 'AUTOMATION_FAILURE')).toBe(true);
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
