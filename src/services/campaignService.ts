import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import {
  CampaignRepository,
  type CampaignRecord,
  type CampaignRecipientRecord,
  type CampaignStatus,
  type CampaignMessageType,
} from '../repositories/campaignRepository.js';
import { whatsappOutboundMessageService } from './whatsappOutboundMessageService.js';
import { WhatsAppOutboundMessageRepository } from '../repositories/whatsappOutboundMessageRepository.js';
import { EntitlementService } from './entitlementService.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { notifyBusiness } from './notificationService.js';
import { type EntitlementDeniedError } from './workspaceService.js';
import { storeMedia } from '../media/mediaStorage.js';

const campaignRepository = new CampaignRepository(pool);
const outboundMessageRepository = new WhatsAppOutboundMessageRepository(pool);
const entitlementService = new EntitlementService(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class CampaignNotFoundError extends Error {}
export class InvalidCampaignStatusError extends Error {}
export class NoEligibleRecipientsError extends Error {}
export class TooManyRecipientsError extends Error {}

/**
 * A hard, plan-independent safety ceiling on top of the real per-plan
 * "max_active_campaigns" entitlement enforced below - keeps this feature
 * firmly in the "small recipient sends" shape the directive scoped it to,
 * not a mass-blast tool, even on an unlimited enterprise plan.
 */
const MAX_RECIPIENTS_PER_CAMPAIGN = 100;

/** Real pacing between sends (BullMQ job delay) - never all recipients messaged in the same instant. */
const SEND_STAGGER_MS = 4000;

async function requireOwnCampaign(businessId: string, campaignId: string): Promise<CampaignRecord> {
  const campaign = await campaignRepository.findByIdForBusiness(businessId, campaignId);
  if (!campaign) throw new CampaignNotFoundError('Campaign not found.');
  return campaign;
}

function requireStatus(campaign: CampaignRecord, allowed: CampaignStatus[]): void {
  if (!allowed.includes(campaign.status)) {
    throw new InvalidCampaignStatusError(`Campaign is "${campaign.status}" - this action requires one of: ${allowed.join(', ')}.`);
  }
}

/** Same real limit whatsappOutboundMessageService.ts enforces for the ordinary 1:1 composer - not exported from there, so kept as its own constant here rather than reaching into that module's internals. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface CampaignAttachmentInput {
  messageType: Exclude<CampaignMessageType, 'text'>;
  mediaBase64: string;
  mediaMimeType: string;
  mediaFileName?: string | undefined;
}

export interface CreateCampaignInput {
  name: string;
  messageText: string;
  crmContactIds: string[];
  attachment?: CampaignAttachmentInput | undefined;
}

/**
 * Stores a campaign's attachment exactly once (at creation or draft-edit
 * time), never per recipient - sendCampaign() below reuses the resulting
 * storage reference for every real send, the same "process the bytes
 * once" reasoning MAX_RECIPIENTS_PER_CAMPAIGN's own cap already assumes.
 * Mirrors whatsappOutboundMessageService.send()'s own decode/hash/store
 * steps exactly, since it's storing into the same real encrypted media
 * backend.
 */
async function storeCampaignAttachment(
  businessId: string,
  attachment: CampaignAttachmentInput,
): Promise<{ messageType: CampaignMessageType; mediaStorageReference: string; mediaMimeType: string; mediaFileName: string | undefined }> {
  const buffer = Buffer.from(attachment.mediaBase64, 'base64');
  if (buffer.length === 0) throw new Error('Decoded media is empty');
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error(`Media exceeds the ${MAX_MEDIA_BYTES} byte limit`);
  const sha256Hex = createHash('sha256').update(buffer).digest('hex');
  const mediaStorageReference = await storeMedia(businessId, sha256Hex, buffer);
  return { messageType: attachment.messageType, mediaStorageReference, mediaMimeType: attachment.mediaMimeType, mediaFileName: attachment.mediaFileName };
}

export interface CreateCampaignResult {
  campaign: CampaignRecord;
  requestedCount: number;
  addedCount: number;
  skippedCrmContactIds: string[];
}

/**
 * Recipients are resolved against listEligibleRecipients (real conversation
 * required, opt-out respected) - a requested contact id that isn't in that
 * eligible set is silently excluded here and reported back in
 * skippedCrmContactIds, never silently dropped without explanation and
 * never force-added anyway.
 */
export async function createCampaign(
  businessId: string,
  whatsappAccountId: string,
  createdBy: string,
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  const requestedIds = Array.from(new Set(input.crmContactIds));
  if (requestedIds.length > MAX_RECIPIENTS_PER_CAMPAIGN) {
    throw new TooManyRecipientsError(`A campaign can target at most ${MAX_RECIPIENTS_PER_CAMPAIGN} recipients (requested ${requestedIds.length}).`);
  }

  const entitlementCheck = await entitlementService.canCreateCampaign(businessId);
  if (!entitlementCheck.allowed) {
    const error = new Error(`Campaign creation denied: ${entitlementCheck.reason}`) as EntitlementDeniedError;
    error.code = 'ENTITLEMENT_DENIED';
    error.reason = entitlementCheck.reason as EntitlementDeniedError['reason'];
    error.limit = entitlementCheck.limit;
    error.current = entitlementCheck.current;
    throw error;
  }

  const eligible = await campaignRepository.listEligibleRecipients(businessId, whatsappAccountId);
  const eligibleById = new Map(eligible.map((recipient) => [recipient.crmContactId, recipient]));

  const toAdd = requestedIds.filter((id) => eligibleById.has(id));
  const skipped = requestedIds.filter((id) => !eligibleById.has(id));

  if (toAdd.length === 0) throw new NoEligibleRecipientsError('None of the selected contacts have an existing conversation to send to.');

  const stored = input.attachment ? await storeCampaignAttachment(businessId, input.attachment) : null;
  const campaign = await campaignRepository.create({
    businessId,
    whatsappAccountId,
    createdBy,
    name: input.name.trim(),
    messageText: input.messageText,
    ...(stored
      ? { messageType: stored.messageType, mediaStorageReference: stored.mediaStorageReference, mediaMimeType: stored.mediaMimeType, mediaFileName: stored.mediaFileName }
      : {}),
  });
  await campaignRepository.createRecipients(
    campaign.id,
    toAdd.map((id) => {
      const recipient = eligibleById.get(id);
      if (!recipient) throw new Error('unreachable: id was filtered from eligibleById');
      return { crmContactId: recipient.crmContactId, chatId: recipient.chatId };
    }),
  );

  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId,
    eventType: 'campaign_created',
    rawMetadata: { campaignId: campaign.id, recipientCount: toAdd.length },
  });

  return { campaign, requestedCount: requestedIds.length, addedCount: toAdd.length, skippedCrmContactIds: skipped };
}

export async function listEligibleCampaignRecipients(businessId: string, whatsappAccountId: string) {
  return campaignRepository.listEligibleRecipients(businessId, whatsappAccountId);
}

export async function listCampaigns(businessId: string): Promise<(CampaignRecord & { counts: Awaited<ReturnType<typeof campaignRepository.getStatusCounts>> })[]> {
  const campaigns = await campaignRepository.listForBusiness(businessId);
  const withCounts = await Promise.all(
    campaigns.map(async (campaign) => {
      const refreshed = await maybeCompleteRunningCampaign(campaign);
      const counts = await campaignRepository.getStatusCounts(refreshed.id);
      return { ...refreshed, counts };
    }),
  );
  return withCounts;
}

export interface CampaignDetail {
  campaign: CampaignRecord;
  recipients: CampaignRecipientRecord[];
  counts: Awaited<ReturnType<typeof campaignRepository.getStatusCounts>>;
}

export async function getCampaign(businessId: string, campaignId: string): Promise<CampaignDetail> {
  const campaign = await requireOwnCampaign(businessId, campaignId);
  const refreshed = await maybeCompleteRunningCampaign(campaign);
  const [recipients, counts] = await Promise.all([
    campaignRepository.listRecipients(refreshed.id),
    campaignRepository.getStatusCounts(refreshed.id),
  ]);
  return { campaign: refreshed, recipients, counts };
}

/**
 * A RUNNING campaign flips to COMPLETED once every recipient has reached a
 * real terminal outbound state (sent-or-later, or failed) - checked live on
 * every read rather than via a separate background poller in this slice.
 * Honest either way: the flip only ever reflects what the real send
 * pipeline already recorded.
 */
async function maybeCompleteRunningCampaign(campaign: CampaignRecord): Promise<CampaignRecord> {
  if (campaign.status !== 'RUNNING') return campaign;
  const counts = await campaignRepository.getStatusCounts(campaign.id);
  if (counts.queued > 0) return campaign;
  const updated = await campaignRepository.updateStatus(campaign.id, 'COMPLETED', { completedAt: true });
  return updated ?? campaign;
}

export async function updateDraftCampaign(
  businessId: string,
  campaignId: string,
  input: { name: string; messageText: string; attachment?: CampaignAttachmentInput | undefined; removeAttachment?: boolean | undefined },
): Promise<CampaignRecord> {
  const campaign = await requireOwnCampaign(businessId, campaignId);
  requireStatus(campaign, ['DRAFT']);

  const stored = input.attachment ? await storeCampaignAttachment(businessId, input.attachment) : null;
  const updated = await campaignRepository.updateDraft(campaignId, {
    name: input.name.trim(),
    messageText: input.messageText,
    ...(stored
      ? { messageType: stored.messageType, mediaStorageReference: stored.mediaStorageReference, mediaMimeType: stored.mediaMimeType, mediaFileName: stored.mediaFileName }
      : input.removeAttachment
        ? { messageType: 'text' as const, mediaStorageReference: null, mediaMimeType: null, mediaFileName: null }
        : {}),
  });
  if (!updated) throw new CampaignNotFoundError('Campaign not found.');
  return updated;
}

export async function submitCampaignForReview(businessId: string, campaignId: string): Promise<CampaignRecord> {
  const campaign = await requireOwnCampaign(businessId, campaignId);
  requireStatus(campaign, ['DRAFT']);
  const updated = await campaignRepository.updateStatus(campaignId, 'REVIEW');
  if (!updated) throw new CampaignNotFoundError('Campaign not found.');
  return updated;
}

export async function approveCampaign(businessId: string, campaignId: string, approvedBy: string): Promise<CampaignRecord> {
  const campaign = await requireOwnCampaign(businessId, campaignId);
  requireStatus(campaign, ['REVIEW']);
  const updated = await campaignRepository.updateStatus(campaignId, 'APPROVED', { approvedBy, approvedAt: true });
  if (!updated) throw new CampaignNotFoundError('Campaign not found.');
  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: campaign.whatsappAccountId,
    eventType: 'campaign_approved',
    rawMetadata: { campaignId, approvedBy },
  });
  return updated;
}

/**
 * The real send. Every recipient gets a genuine outbound message queued
 * through the exact same pipeline a 1:1 composer send uses (idempotent,
 * retried by BullMQ, tracked to a real terminal status) - staggered so
 * WhatsApp never sees a burst of simultaneous sends from one account.
 */
export async function sendCampaign(businessId: string, campaignId: string): Promise<CampaignRecord> {
  const campaign = await requireOwnCampaign(businessId, campaignId);
  requireStatus(campaign, ['APPROVED']);

  const pending = await campaignRepository.listUndispatchedRecipients(campaignId);
  if (pending.length === 0) throw new NoEligibleRecipientsError('This campaign has no recipients to send to.');

  const running = await campaignRepository.updateStatus(campaignId, 'RUNNING', { sentAt: true });
  if (!running) throw new CampaignNotFoundError('Campaign not found.');

  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: campaign.whatsappAccountId,
    eventType: 'campaign_sent',
    rawMetadata: { campaignId, recipientCount: pending.length },
  });

  let index = 0;
  let failedCount = 0;
  for (const recipient of pending) {
    try {
      const isText = campaign.messageType === 'text';
      const outboundMessage = await whatsappOutboundMessageService.send({
        businessId,
        whatsappAccountId: campaign.whatsappAccountId,
        chatId: recipient.chatId,
        messageType: campaign.messageType,
        requestedBy: 'campaign',
        delayMs: index * SEND_STAGGER_MS,
        ...(isText
          ? { text: campaign.messageText }
          : {
              caption: campaign.messageText,
              mediaStorageReference: campaign.mediaStorageReference ?? undefined,
              mediaMimeType: campaign.mediaMimeType ?? undefined,
              mediaFileName: campaign.mediaFileName ?? undefined,
            }),
      });
      await campaignRepository.linkOutboundMessage(recipient.id, outboundMessage.id);
    } catch (error) {
      // A single recipient's dispatch failing (e.g. their chat vanished)
      // must not abort the rest of a real campaign send - but it must also
      // never be silent: recorded as a real terminal failure (never left
      // outbound_message_id NULL forever, which getStatusCounts would have
      // read as permanently 'queued', wedging the whole campaign in RUNNING).
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[CampaignService] Failed to dispatch campaign ${campaignId} to recipient ${recipient.id}:`, error);
      await campaignRepository.recordDispatchFailure(recipient.id, message);
      failedCount += 1;
    }
    index += 1;
  }

  if (failedCount > 0) {
    await notifyBusiness({
      businessId,
      type: 'AUTOMATION_FAILURE',
      severity: 'warning',
      title: 'Some campaign messages could not be sent',
      body: `${failedCount} of ${pending.length} recipient(s) in "${campaign.name}" could not be dispatched (e.g. their conversation no longer exists). Check the campaign detail for which ones.`,
      targetType: 'campaign',
      targetId: campaignId,
    }).catch((notifyError) => {
      console.error('[CampaignService] Failed to dispatch AUTOMATION_FAILURE notification:', notifyError);
    });
  }

  return running;
}

/**
 * The emergency stop: DRAFT/REVIEW/APPROVED simply never sent anything, so
 * cancelling there is bookkeeping only. RUNNING is the real case - by the
 * time sendCampaign() returns, every recipient already has a real 'queued'
 * outbound message with a staggered BullMQ delay (SEND_STAGGER_MS apart),
 * so for up to MAX_RECIPIENTS_PER_CAMPAIGN * SEND_STAGGER_MS after Send is
 * clicked, some recipients genuinely have not been messaged yet. Before
 * this, a mistake spotted in that window (wrong price, wrong message, wrong
 * list) had no way to be stopped - requireStatus refused anything past
 * APPROVED. Recipients already 'sending'/'sent'/'indeterminate' by the time
 * this runs are deliberately left alone (cancelQueuedByIds only ever
 * matches 'queued') - a message that may have already reached WhatsApp is
 * never raced against a cancel.
 */
export async function cancelCampaign(businessId: string, campaignId: string): Promise<CampaignRecord> {
  const campaign = await requireOwnCampaign(businessId, campaignId);
  requireStatus(campaign, ['DRAFT', 'REVIEW', 'APPROVED', 'RUNNING']);
  const wasRunning = campaign.status === 'RUNNING';
  const updated = await campaignRepository.updateStatus(campaignId, 'CANCELLED');
  if (!updated) throw new CampaignNotFoundError('Campaign not found.');

  let stoppedCount = 0;
  if (wasRunning) {
    const outboundMessageIds = await campaignRepository.listOutboundMessageIds(campaignId);
    stoppedCount = (await outboundMessageRepository.cancelQueuedByIds(businessId, outboundMessageIds)).length;
  }

  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: campaign.whatsappAccountId,
    eventType: 'campaign_cancelled',
    rawMetadata: { campaignId, wasRunning, stoppedCount },
  });
  return updated;
}

export async function deleteCampaign(businessId: string, campaignId: string): Promise<void> {
  const campaign = await requireOwnCampaign(businessId, campaignId);
  requireStatus(campaign, ['CANCELLED', 'COMPLETED', 'FAILED']);
  const deleted = await campaignRepository.hardDelete(businessId, campaignId);
  if (!deleted) throw new CampaignNotFoundError('Campaign not found.');
  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: campaign.whatsappAccountId,
    eventType: 'campaign_deleted',
    rawMetadata: { campaignId },
  });
}

export function isCampaignNotFoundError(error: unknown): error is CampaignNotFoundError {
  return error instanceof CampaignNotFoundError;
}
export function isInvalidCampaignStatusError(error: unknown): error is InvalidCampaignStatusError {
  return error instanceof InvalidCampaignStatusError;
}
export function isNoEligibleRecipientsError(error: unknown): error is NoEligibleRecipientsError {
  return error instanceof NoEligibleRecipientsError;
}
export function isTooManyRecipientsError(error: unknown): error is TooManyRecipientsError {
  return error instanceof TooManyRecipientsError;
}
