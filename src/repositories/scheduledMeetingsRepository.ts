import type { Queryable } from './types.js';
import type { MeetingProvider } from '../services/meeting/meetingProvider.js';

export type ScheduledMeetingRecord = {
  id: string;
  businessId: string;
  chatId: string | null;
  contactId: string | null;
  agentId: string | null;
  googleConnectionId: string | null;
  zoomConnectionId: string | null;
  provider: MeetingProvider;
  status: 'confirmed' | 'cancelled' | 'failed' | 'completed' | 'no_show';
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  attendeeEmail: string | null;
  attendeeName: string | null;
  externalEventId: string;
  meetUrl: string;
  calendarHtmlLink: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
};

type CreateMeetingInput = {
  businessId: string;
  chatId: string | null;
  contactId: string | null;
  agentId: string | null;
  title: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
  externalEventId: string;
  meetUrl: string;
  calendarHtmlLink?: string | null;
} & (
  | { provider: 'google_meet'; googleConnectionId: string }
  | { provider: 'zoom'; zoomConnectionId: string }
);

/**
 * The shared real-booking-history table (scheduled_meetings) - genuinely
 * shared across providers since phase 2 (Zoom) added a second connection
 * type; exactly one of google_connection_id/zoom_connection_id is set per
 * row, enforced by the database's own
 * scheduled_meetings_exactly_one_connection CHECK
 * (949_scheduled_meetings_multi_provider.sql), not just application logic.
 * Connection CRUD (tokens, OAuth) stays in googleMeetingRepository.ts /
 * zoomMeetingRepository.ts - this repository only ever touches the meeting
 * rows themselves.
 */
export class ScheduledMeetingsRepository {
  constructor(private readonly db: Queryable) {}

  async createMeeting(input: CreateMeetingInput): Promise<ScheduledMeetingRecord> {
    const googleConnectionId = input.provider === 'google_meet' ? input.googleConnectionId : null;
    const zoomConnectionId = input.provider === 'zoom' ? input.zoomConnectionId : null;

    const result = await this.db.query(
      `INSERT INTO scheduled_meetings
         (business_id, chat_id, contact_id, agent_id, provider, google_connection_id, zoom_connection_id, title,
          start_at, end_at, timezone, attendee_email, attendee_name, external_event_id, meet_url, calendar_html_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        input.businessId,
        input.chatId,
        input.contactId,
        input.agentId,
        input.provider,
        googleConnectionId,
        zoomConnectionId,
        input.title,
        input.startAt.toISOString(),
        input.endAt.toISOString(),
        input.timezone,
        input.attendeeEmail ?? null,
        input.attendeeName ?? null,
        input.externalEventId,
        input.meetUrl,
        input.calendarHtmlLink ?? null,
      ],
    );
    return this.mapMeeting(result.rows[0] as Record<string, unknown>);
  }

  async listByChat(chatId: string, businessId: string): Promise<ScheduledMeetingRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM scheduled_meetings WHERE chat_id = $1 AND business_id = $2 ORDER BY start_at DESC`,
      [chatId, businessId],
    );
    return result.rows.map((r) => this.mapMeeting(r as Record<string, unknown>));
  }

  /** Section 48 (Autonomous Morning Briefing): real meetings actually booked since a point in time - never a fabricated appointment count. */
  async listCreatedSince(businessId: string, sinceIso: string, limit = 50): Promise<ScheduledMeetingRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM scheduled_meetings WHERE business_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT $3`,
      [businessId, sinceIso, limit],
    );
    return result.rows.map((r) => this.mapMeeting(r as Record<string, unknown>));
  }

  /** Section 56 (Appointment System) - every real meeting for this business, most-imminent-first, the real material for a dedicated Appointments page (none existed anywhere in the UI before this). */
  async listForBusiness(businessId: string, limit = 200): Promise<ScheduledMeetingRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM scheduled_meetings WHERE business_id = $1 ORDER BY start_at DESC LIMIT $2`,
      [businessId, limit],
    );
    return result.rows.map((r) => this.mapMeeting(r as Record<string, unknown>));
  }

  /**
   * Section 56's lifecycle: until this method, scheduled_meetings had
   * literally no UPDATE statement anywhere in the codebase - a meeting's
   * status never changed after creation, despite cancelled/failed already
   * being declared types. This is the first real mutation of this table.
   * 'completed' is set only by the real sweep below (endAt has genuinely
   * passed), never by this generic setter with an arbitrary status - use
   * the dedicated methods below for that and for no_show.
   */
  async markCancelled(businessId: string, id: string): Promise<ScheduledMeetingRecord | null> {
    const result = await this.db.query(
      `UPDATE scheduled_meetings SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE id = $1 AND business_id = $2 AND status = 'confirmed'
       RETURNING *`,
      [id, businessId],
    );
    return result.rows[0] ? this.mapMeeting(result.rows[0] as Record<string, unknown>) : null;
  }

  /** Only a human can know whether someone actually attended - never set automatically. */
  async markNoShow(businessId: string, id: string): Promise<ScheduledMeetingRecord | null> {
    const result = await this.db.query(
      `UPDATE scheduled_meetings SET status = 'no_show', updated_at = now()
       WHERE id = $1 AND business_id = $2 AND status = 'confirmed'
       RETURNING *`,
      [id, businessId],
    );
    return result.rows[0] ? this.mapMeeting(result.rows[0] as Record<string, unknown>) : null;
  }

  /** Real, computable fact for the completion sweep: a confirmed meeting whose end has genuinely already passed. Never includes cancelled/failed/no_show rows - those are terminal in a different direction. */
  async findConfirmedPastEnd(beforeIso: string, limit = 500): Promise<ScheduledMeetingRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM scheduled_meetings WHERE status = 'confirmed' AND end_at < $1 LIMIT $2`,
      [beforeIso, limit],
    );
    return result.rows.map((r) => this.mapMeeting(r as Record<string, unknown>));
  }

  async markCompleted(id: string): Promise<void> {
    await this.db.query(`UPDATE scheduled_meetings SET status = 'completed', updated_at = now() WHERE id = $1 AND status = 'confirmed'`, [id]);
  }

  // Timestamp columns come back as plain ISO strings, not Date objects - the
  // pool's global TIMESTAMPTZ type parser (src/db/pool.ts) already converts
  // them - same convention as googleMeetingRepository.ts's own mapConnection().
  private mapMeeting(row: Record<string, unknown>): ScheduledMeetingRecord {
    return {
      id: row['id'] as string,
      businessId: row['business_id'] as string,
      chatId: row['chat_id'] as string | null,
      contactId: row['contact_id'] as string | null,
      agentId: row['agent_id'] as string | null,
      googleConnectionId: row['google_connection_id'] as string | null,
      zoomConnectionId: row['zoom_connection_id'] as string | null,
      provider: row['provider'] as MeetingProvider,
      status: row['status'] as 'confirmed' | 'cancelled' | 'failed' | 'completed' | 'no_show',
      title: row['title'] as string,
      startAt: row['start_at'] as string,
      endAt: row['end_at'] as string,
      timezone: row['timezone'] as string,
      attendeeEmail: row['attendee_email'] as string | null,
      attendeeName: row['attendee_name'] as string | null,
      externalEventId: row['external_event_id'] as string,
      meetUrl: row['meet_url'] as string,
      calendarHtmlLink: row['calendar_html_link'] as string | null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      cancelledAt: row['cancelled_at'] as string | null,
    };
  }
}
