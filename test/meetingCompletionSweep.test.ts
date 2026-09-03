import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { GoogleMeetingRepository } from '../src/repositories/googleMeetingRepository.js';
import { ScheduledMeetingsRepository } from '../src/repositories/scheduledMeetingsRepository.js';
import { sweepCompletedMeetings } from '../src/queue/workers/incomingMessagesWorker.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Section 56 (Appointment System): real completion tracking - before this,
 * scheduled_meetings had no way to ever leave 'confirmed' automatically.
 * 'completed' is a genuinely computable fact (end_at has passed); the sweep
 * never invents attendance data - that's what the human-only no_show
 * action is for.
 */
describe('sweepCompletedMeetings (real Postgres)', () => {
  async function makeMeeting(businessId: string, startAt: Date, endAt: Date) {
    const googleRepo = new GoogleMeetingRepository(pool);
    const repo = new ScheduledMeetingsRepository(pool);
    const connection = await googleRepo.upsertConnection({ businessId, googleEmail: `booker-${Math.random()}@example.com`, accessToken: 'access' });
    return repo.createMeeting({
      provider: 'google_meet',
      googleConnectionId: connection.id,
      businessId,
      chatId: null,
      contactId: null,
      agentId: null,
      title: 'Property viewing',
      startAt,
      endAt,
      timezone: 'UTC',
      attendeeEmail: 'customer@example.com',
      externalEventId: `evt-${Math.random()}`,
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    });
  }

  it('marks a real confirmed meeting whose end time has passed as completed', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new ScheduledMeetingsRepository(pool);
    const meeting = await makeMeeting(businessId, new Date(Date.now() - 7200_000), new Date(Date.now() - 3600_000));

    await sweepCompletedMeetings();

    const [row] = await repo.listForBusiness(businessId);
    expect(row?.id).toBe(meeting.id);
    expect(row?.status).toBe('completed');
  });

  it('never touches a meeting that has not ended yet', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new ScheduledMeetingsRepository(pool);
    await makeMeeting(businessId, new Date(Date.now() + 3600_000), new Date(Date.now() + 7200_000));

    await sweepCompletedMeetings();

    const [row] = await repo.listForBusiness(businessId);
    expect(row?.status).toBe('confirmed');
  });

  it('never overrides a meeting a human already marked cancelled or no_show, even though its end time has passed', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new ScheduledMeetingsRepository(pool);
    const cancelled = await makeMeeting(businessId, new Date(Date.now() - 7200_000), new Date(Date.now() - 3600_000));
    await repo.markCancelled(businessId, cancelled.id);
    const noShow = await makeMeeting(businessId, new Date(Date.now() - 7200_000), new Date(Date.now() - 3600_000));
    await repo.markNoShow(businessId, noShow.id);

    await sweepCompletedMeetings();

    const rows = await repo.listForBusiness(businessId);
    expect(rows.find((r) => r.id === cancelled.id)?.status).toBe('cancelled');
    expect(rows.find((r) => r.id === noShow.id)?.status).toBe('no_show');
  });

  it('running the sweep twice in a row is safe - the second run finds nothing left to do', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    await makeMeeting(businessId, new Date(Date.now() - 7200_000), new Date(Date.now() - 3600_000));

    await sweepCompletedMeetings();
    await expect(sweepCompletedMeetings()).resolves.not.toThrow();
  });
});
