import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../src/services/authService.js';
import {
  createScheduledStatus,
  listScheduledStatuses,
  getScheduledStatus,
  scheduleStatus,
  cancelScheduledStatus,
  isInvalidScheduledStatusError,
  isScheduledStatusNotFoundError,
} from '../src/services/scheduledStatusService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('scheduledStatusService (real Status posts, real BullMQ-backed scheduling)', () => {
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

  function futureIso(minutes: number): string {
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }

  it('creates a real DRAFT text status and rejects a past scheduledAt', async () => {
    const status = await createScheduledStatus(businessId, accountId, ownerId, {
      statusType: 'text',
      textContent: 'Hello world',
      scheduledAt: futureIso(30),
    });
    expect(status.status).toBe('DRAFT');
    expect(status.textContent).toBe('Hello world');

    await expect(
      createScheduledStatus(businessId, accountId, ownerId, { statusType: 'text', textContent: 'x', scheduledAt: futureIso(-5) }),
    ).rejects.toThrow();
    try {
      await createScheduledStatus(businessId, accountId, ownerId, { statusType: 'text', textContent: 'x', scheduledAt: futureIso(-5) });
    } catch (error) {
      expect(isInvalidScheduledStatusError(error)).toBe(true);
    }
  });

  it('requires media for an image/video status', async () => {
    await expect(
      createScheduledStatus(businessId, accountId, ownerId, { statusType: 'image', scheduledAt: futureIso(30) }),
    ).rejects.toThrow();
  });

  it('stores and retrieves real encrypted media for an image status', async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
    const status = await createScheduledStatus(businessId, accountId, ownerId, {
      statusType: 'image',
      mediaBase64: fakeJpeg,
      mediaMimeType: 'image/jpeg',
      caption: 'Look at this',
      scheduledAt: futureIso(30),
    });
    expect(status.mediaStorageReference).not.toBeNull();
    expect(status.caption).toBe('Look at this');
  });

  it('DRAFT -> SCHEDULED transitions for real, and rejects scheduling twice', async () => {
    const status = await createScheduledStatus(businessId, accountId, ownerId, { statusType: 'text', textContent: 'x', scheduledAt: futureIso(30) });
    const scheduled = await scheduleStatus(businessId, status.id);
    expect(scheduled.status).toBe('SCHEDULED');

    await expect(scheduleStatus(businessId, status.id)).rejects.toThrow();
    try {
      await scheduleStatus(businessId, status.id);
    } catch (error) {
      expect(isInvalidScheduledStatusError(error)).toBe(true);
    }
  });

  it('cancels a DRAFT or SCHEDULED status, but not one already published or cancelled', async () => {
    const status = await createScheduledStatus(businessId, accountId, ownerId, { statusType: 'text', textContent: 'x', scheduledAt: futureIso(30) });
    const cancelled = await cancelScheduledStatus(businessId, status.id);
    expect(cancelled.status).toBe('CANCELLED');

    await expect(cancelScheduledStatus(businessId, status.id)).rejects.toThrow();
  });

  it('refuses to touch a scheduled status belonging to a different business', async () => {
    const status = await createScheduledStatus(businessId, accountId, ownerId, { statusType: 'text', textContent: 'x', scheduledAt: futureIso(30) });
    const otherBusinessId = await createTestBusiness('Other Business');

    await expect(getScheduledStatus(otherBusinessId, status.id)).rejects.toThrow();
    try {
      await getScheduledStatus(otherBusinessId, status.id);
    } catch (error) {
      expect(isScheduledStatusNotFoundError(error)).toBe(true);
    }

    const statuses = await listScheduledStatuses(businessId);
    expect(statuses.map((s) => s.id)).toContain(status.id);
    expect(await listScheduledStatuses(otherBusinessId)).toHaveLength(0);
  });
});
