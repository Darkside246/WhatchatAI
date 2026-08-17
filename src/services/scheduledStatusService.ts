import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { ScheduledStatusRepository, type ScheduledStatusRecord, type ScheduledStatusType } from '../repositories/scheduledStatusRepository.js';
import { enqueueScheduledStatus } from '../queue/queues/scheduledStatusesQueue.js';
import { storeMedia } from '../media/localEncryptedMediaStorage.js';

const scheduledStatusRepository = new ScheduledStatusRepository(pool);

export class ScheduledStatusNotFoundError extends Error {}
export class InvalidScheduledStatusError extends Error {}

const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface CreateScheduledStatusInput {
  statusType: ScheduledStatusType;
  textContent?: string | undefined;
  caption?: string | undefined;
  backgroundColor?: string | undefined;
  mediaBase64?: string | undefined;
  mediaMimeType?: string | undefined;
  scheduledAt: string;
}

async function requireOwn(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  const record = await scheduledStatusRepository.findByIdForBusiness(businessId, id);
  if (!record) throw new ScheduledStatusNotFoundError('Scheduled status not found.');
  return record;
}

export async function createScheduledStatus(
  businessId: string,
  whatsappAccountId: string,
  createdBy: string,
  input: CreateScheduledStatusInput,
): Promise<ScheduledStatusRecord> {
  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
    throw new InvalidScheduledStatusError('scheduledAt must be a real, future timestamp.');
  }

  let mediaStorageReference: string | null = null;
  if (input.statusType !== 'text') {
    if (!input.mediaBase64) throw new InvalidScheduledStatusError(`statusType "${input.statusType}" requires mediaBase64`);
    const buffer = Buffer.from(input.mediaBase64, 'base64');
    if (buffer.length === 0) throw new InvalidScheduledStatusError('Decoded media is empty');
    if (buffer.length > MAX_MEDIA_BYTES) throw new InvalidScheduledStatusError(`Media exceeds the ${MAX_MEDIA_BYTES} byte limit`);
    const sha256Hex = createHash('sha256').update(buffer).digest('hex');
    mediaStorageReference = await storeMedia(businessId, sha256Hex, buffer);
  } else if (!input.textContent?.trim()) {
    throw new InvalidScheduledStatusError('statusType "text" requires non-empty textContent');
  }

  return scheduledStatusRepository.create({
    businessId,
    whatsappAccountId,
    createdBy,
    statusType: input.statusType,
    textContent: input.statusType === 'text' ? (input.textContent ?? null) : null,
    caption: input.caption ?? null,
    backgroundColor: input.backgroundColor ?? null,
    mediaStorageReference,
    mediaMimeType: input.mediaMimeType ?? null,
    scheduledAt: scheduledAt.toISOString(),
  });
}

export async function listScheduledStatuses(businessId: string): Promise<ScheduledStatusRecord[]> {
  return scheduledStatusRepository.listForBusiness(businessId);
}

export async function getScheduledStatus(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  return requireOwn(businessId, id);
}

/** DRAFT -> SCHEDULED, and the real BullMQ delayed job that will actually fire the publish. */
export async function scheduleStatus(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  const record = await requireOwn(businessId, id);
  if (record.status !== 'DRAFT') throw new InvalidScheduledStatusError(`Status is "${record.status}" - only a DRAFT can be scheduled.`);

  const delayMs = new Date(record.scheduledAt).getTime() - Date.now();
  if (delayMs <= 0) throw new InvalidScheduledStatusError('scheduledAt has already passed - update it before scheduling.');

  const updated = await scheduledStatusRepository.updateStatus(id, 'SCHEDULED');
  if (!updated) throw new ScheduledStatusNotFoundError('Scheduled status not found.');
  await enqueueScheduledStatus({ scheduledStatusId: id }, delayMs);
  return updated;
}

export async function cancelScheduledStatus(businessId: string, id: string): Promise<ScheduledStatusRecord> {
  const record = await requireOwn(businessId, id);
  if (record.status !== 'DRAFT' && record.status !== 'SCHEDULED') {
    throw new InvalidScheduledStatusError(`Status is "${record.status}" - it can no longer be cancelled.`);
  }
  const updated = await scheduledStatusRepository.updateStatus(id, 'CANCELLED');
  if (!updated) throw new ScheduledStatusNotFoundError('Scheduled status not found.');
  return updated;
}

export function isScheduledStatusNotFoundError(error: unknown): error is ScheduledStatusNotFoundError {
  return error instanceof ScheduledStatusNotFoundError;
}
export function isInvalidScheduledStatusError(error: unknown): error is InvalidScheduledStatusError {
  return error instanceof InvalidScheduledStatusError;
}
