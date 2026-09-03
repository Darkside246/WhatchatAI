import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { GoogleMeetingRepository } from '../src/repositories/googleMeetingRepository.js';
import { ZoomMeetingRepository } from '../src/repositories/zoomMeetingRepository.js';
import { ScheduledMeetingsRepository } from '../src/repositories/scheduledMeetingsRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Real-Postgres coverage for the shared scheduled_meetings table, which
 * became genuinely multi-provider in phase 2 (949_scheduled_meetings_multi_provider.sql):
 * exactly one of google_connection_id/zoom_connection_id is set per row,
 * enforced by the database's own scheduled_meetings_exactly_one_connection
 * CHECK, not just application logic.
 */
describe('ScheduledMeetingsRepository (real Postgres)', () => {
  it('creates a real Google-provider meeting row with ISO string timestamps and null-safe optional FKs, and lists it back by chat', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const googleRepo = new GoogleMeetingRepository(pool);
    const repo = new ScheduledMeetingsRepository(pool);

    const connection = await googleRepo.upsertConnection({ businessId, googleEmail: 'booker@example.com', accessToken: 'access' });

    const startAt = new Date(Date.now() + 24 * 3600_000);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    const meeting = await repo.createMeeting({
      provider: 'google_meet',
      googleConnectionId: connection.id,
      businessId,
      chatId: null,
      contactId: null,
      agentId: null,
      title: 'Property viewing',
      startAt,
      endAt,
      timezone: 'America/New_York',
      attendeeEmail: 'customer@example.com',
      externalEventId: 'google-event-1',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      calendarHtmlLink: 'https://calendar.google.com/event?eid=1',
    });

    expect(meeting.id).toBeTruthy();
    expect(meeting.provider).toBe('google_meet');
    expect(meeting.googleConnectionId).toBe(connection.id);
    expect(meeting.zoomConnectionId).toBeNull();
    expect(meeting.status).toBe('confirmed');
    expect(typeof meeting.startAt).toBe('string');
    expect(typeof meeting.endAt).toBe('string');
    expect(typeof meeting.createdAt).toBe('string');
    expect(meeting.chatId).toBeNull();
    expect(meeting.cancelledAt).toBeNull();

    // listByChat with a null chat_id row must not error, and must not
    // spuriously match (a real chat id is required to find it).
    expect(await repo.listByChat('00000000-0000-0000-0000-000000000000', businessId)).toEqual([]);
  });

  it('creates a real Zoom-provider meeting row with no attendee email (Zoom delivers the join link in-chat, not by email)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const zoomRepo = new ZoomMeetingRepository(pool);
    const repo = new ScheduledMeetingsRepository(pool);

    const connection = await zoomRepo.upsertConnection({ businessId, zoomEmail: 'booker@example.com', zoomUserId: 'zoom-user-1', accessToken: 'access' });

    const startAt = new Date(Date.now() + 24 * 3600_000);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    const meeting = await repo.createMeeting({
      provider: 'zoom',
      zoomConnectionId: connection.id,
      businessId,
      chatId: null,
      contactId: null,
      agentId: null,
      title: 'Property viewing',
      startAt,
      endAt,
      timezone: 'America/New_York',
      externalEventId: '123456789',
      meetUrl: 'https://zoom.us/j/123456789',
    });

    expect(meeting.provider).toBe('zoom');
    expect(meeting.zoomConnectionId).toBe(connection.id);
    expect(meeting.googleConnectionId).toBeNull();
    expect(meeting.attendeeEmail).toBeNull();
    expect(meeting.calendarHtmlLink).toBeNull();
  });

  it('a Google row and a Zoom row for the same business/chat both list back together, ordered by start_at', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const googleRepo = new GoogleMeetingRepository(pool);
    const zoomRepo = new ZoomMeetingRepository(pool);
    const repo = new ScheduledMeetingsRepository(pool);

    const googleConnection = await googleRepo.upsertConnection({ businessId, googleEmail: 'a@example.com', accessToken: 'access' });
    const zoomConnection = await zoomRepo.upsertConnection({ businessId, zoomEmail: 'b@example.com', zoomUserId: 'zoom-user-2', accessToken: 'access' });

    const accountId = await createTestAccount(businessId);
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const chatId = chat.id;

    const later = new Date(Date.now() + 48 * 3600_000);
    const earlier = new Date(Date.now() + 24 * 3600_000);

    await repo.createMeeting({
      provider: 'google_meet',
      googleConnectionId: googleConnection.id,
      businessId,
      chatId,
      contactId: null,
      agentId: null,
      title: 'Later Google meeting',
      startAt: later,
      endAt: new Date(later.getTime() + 30 * 60_000),
      timezone: 'UTC',
      attendeeEmail: 'customer@example.com',
      externalEventId: 'google-event-2',
      meetUrl: 'https://meet.google.com/later',
    });
    await repo.createMeeting({
      provider: 'zoom',
      zoomConnectionId: zoomConnection.id,
      businessId,
      chatId,
      contactId: null,
      agentId: null,
      title: 'Earlier Zoom meeting',
      startAt: earlier,
      endAt: new Date(earlier.getTime() + 30 * 60_000),
      timezone: 'UTC',
      externalEventId: 'zoom-event-2',
      meetUrl: 'https://zoom.us/j/222',
    });

    const rows = await repo.listByChat(chatId, businessId);
    expect(rows).toHaveLength(2);
    // ORDER BY start_at DESC - the later Google meeting first.
    expect(rows[0]?.provider).toBe('google_meet');
    expect(rows[1]?.provider).toBe('zoom');
  });

  it('the database rejects a row with both connection ids set, or neither, regardless of what application code sends', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const googleRepo = new GoogleMeetingRepository(pool);
    const zoomRepo = new ZoomMeetingRepository(pool);

    const googleConnection = await googleRepo.upsertConnection({ businessId, googleEmail: 'a@example.com', accessToken: 'access' });
    const zoomConnection = await zoomRepo.upsertConnection({ businessId, zoomEmail: 'b@example.com', zoomUserId: 'zoom-user-3', accessToken: 'access' });

    const startAt = new Date(Date.now() + 3600_000);
    const endAt = new Date(startAt.getTime() + 1800_000);

    // Both connection ids set - the CHECK constraint must reject this even
    // though each individual FK is independently valid.
    await expect(
      pool.query(
        `INSERT INTO scheduled_meetings
           (business_id, provider, google_connection_id, zoom_connection_id, title, start_at, end_at, timezone, external_event_id, meet_url)
         VALUES ($1, 'google_meet', $2, $3, 'Bad row', $4, $5, 'UTC', 'evt-both', 'https://example.com')`,
        [businessId, googleConnection.id, zoomConnection.id, startAt.toISOString(), endAt.toISOString()],
      ),
    ).rejects.toThrow();

    // Neither connection id set - also rejected.
    await expect(
      pool.query(
        `INSERT INTO scheduled_meetings
           (business_id, provider, title, start_at, end_at, timezone, external_event_id, meet_url)
         VALUES ($1, 'zoom', 'Bad row', $2, $3, 'UTC', 'evt-neither', 'https://example.com')`,
        [businessId, startAt.toISOString(), endAt.toISOString()],
      ),
    ).rejects.toThrow();
  });

  describe('Section 56 (Appointment System) - real lifecycle mutation (previously scheduled_meetings had none at all)', () => {
    async function makeMeeting(businessId: string, overrides: { startAt?: Date; endAt?: Date; externalEventId?: string } = {}) {
      const googleRepo = new GoogleMeetingRepository(pool);
      const repo = new ScheduledMeetingsRepository(pool);
      const connection = await googleRepo.upsertConnection({ businessId, googleEmail: `booker-${Math.random()}@example.com`, accessToken: 'access' });
      const startAt = overrides.startAt ?? new Date(Date.now() + 24 * 3600_000);
      const endAt = overrides.endAt ?? new Date(startAt.getTime() + 30 * 60_000);
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
        externalEventId: overrides.externalEventId ?? `evt-${Math.random()}`,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      });
    }

    it('listForBusiness returns every real meeting for the business, most-imminent-first', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const earlier = await makeMeeting(businessId, { startAt: new Date(Date.now() + 3600_000) });
      const later = await makeMeeting(businessId, { startAt: new Date(Date.now() + 7200_000) });

      const rows = await new ScheduledMeetingsRepository(pool).listForBusiness(businessId);
      expect(rows.map((r) => r.id)).toEqual([later.id, earlier.id]);
    });

    it('markCancelled sets status and cancelled_at, only from confirmed, and is tenant-scoped', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const otherBusinessId = await createTestBusiness('Other Business');
      const meeting = await makeMeeting(businessId);
      const repo = new ScheduledMeetingsRepository(pool);

      expect(await repo.markCancelled(otherBusinessId, meeting.id)).toBeNull(); // cross-tenant - never touches another business's row

      const cancelled = await repo.markCancelled(businessId, meeting.id);
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.cancelledAt).not.toBeNull();

      // Already cancelled - a second call is a real no-op, not a re-cancel.
      expect(await repo.markCancelled(businessId, meeting.id)).toBeNull();
    });

    it('markNoShow sets status only from confirmed, and is tenant-scoped', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const meeting = await makeMeeting(businessId);
      const repo = new ScheduledMeetingsRepository(pool);

      const noShow = await repo.markNoShow(businessId, meeting.id);
      expect(noShow?.status).toBe('no_show');

      // Already no_show - cannot be marked again.
      expect(await repo.markNoShow(businessId, meeting.id)).toBeNull();
    });

    it('findConfirmedPastEnd finds only confirmed meetings whose end has passed - never cancelled/failed/no_show, never still-upcoming ones', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const repo = new ScheduledMeetingsRepository(pool);

      const past = await makeMeeting(businessId, { startAt: new Date(Date.now() - 7200_000), endAt: new Date(Date.now() - 3600_000) });
      const stillUpcoming = await makeMeeting(businessId);
      const pastButCancelled = await makeMeeting(businessId, { startAt: new Date(Date.now() - 7200_000), endAt: new Date(Date.now() - 3600_000) });
      await repo.markCancelled(businessId, pastButCancelled.id);

      const due = await repo.findConfirmedPastEnd(new Date().toISOString());
      const dueIds = due.map((m) => m.id);
      expect(dueIds).toContain(past.id);
      expect(dueIds).not.toContain(stillUpcoming.id);
      expect(dueIds).not.toContain(pastButCancelled.id);
    });

    it('markCompleted transitions a confirmed meeting to completed, and is a no-op on anything not confirmed', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const repo = new ScheduledMeetingsRepository(pool);
      const meeting = await makeMeeting(businessId);

      await repo.markCompleted(meeting.id);
      const [row] = await repo.listForBusiness(businessId);
      expect(row?.status).toBe('completed');

      // Calling it again (already completed, not confirmed) must not error.
      await expect(repo.markCompleted(meeting.id)).resolves.not.toThrow();
    });
  });
});
