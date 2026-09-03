import { pool } from '../../db/pool.js';
import { GoogleMeetingRepository } from '../../repositories/googleMeetingRepository.js';
import { ScheduledMeetingsRepository } from '../../repositories/scheduledMeetingsRepository.js';
import { getValidAccessToken as getValidGoogleMeetingAccessToken } from '../googleMeetingOAuthService.js';
import { createMeetingEvent } from '../googleCalendarClient.js';
import { notifyBusiness } from '../notificationService.js';

const googleMeetingRepository = new GoogleMeetingRepository(pool);
const scheduledMeetingsRepository = new ScheduledMeetingsRepository(pool);

export interface BookGoogleMeetingInput {
  businessId: string;
  chatId: string;
  contactId: string | null;
  agentId: string;
  businessTimezone: string;
  attendeeEmail: string;
  title: string;
  startDateTimeIso: string;
  durationMinutes?: number;
}

export type BookGoogleMeetingResult =
  | { booked: true; meetUrl: string; startAt: string; title: string }
  | { booked: false; reason: string; detail?: string };

/**
 * The real Google Meet booking side effect - extracted verbatim from
 * aiReplyService.ts's executeOneToolCall so it can be called from two real
 * places with identical behavior: immediately (an agent at autonomy level
 * 3+), or later from GoogleMeetBookingExecutor once an operator approves
 * (an agent at level 1-2). Same honest, never-fabricated-success contract
 * either way: booked: true is only ever returned once a real Calendar
 * event with a real Meet link actually exists.
 */
export async function bookGoogleMeeting(input: BookGoogleMeetingInput): Promise<BookGoogleMeetingResult> {
  if (!input.attendeeEmail || !input.title || !input.startDateTimeIso) {
    return { booked: false, reason: 'missing_required_fields' };
  }
  const connection = await googleMeetingRepository.getConnectionByBusiness(input.businessId);
  if (!connection) {
    return { booked: false, reason: 'not_connected' };
  }

  const accessToken = await getValidGoogleMeetingAccessToken(input.businessId);
  if (!accessToken) {
    // A dead refresh token (revoked from the customer's own Google Account
    // settings, or expired) fails the exact same way on every future
    // booking attempt - AI-driven or operator-approved - with nothing else
    // in the system to ever surface it. Before this, the customer just got
    // told the AI couldn't book anything, and staff had no way to know why
    // short of noticing the pattern themselves.
    await notifyBusiness({
      businessId: input.businessId,
      type: 'AUTOMATION_FAILURE',
      severity: 'warning',
      title: 'Google Meet needs to be reconnected',
      body: 'A booking attempt failed because the Google connection is no longer valid (likely revoked or expired). Reconnect it in Settings to resume booking Meet links.',
      targetType: 'google_meeting_connection',
      targetId: connection.id,
    }).catch((error) => {
      console.error('[bookGoogleMeeting] Failed to dispatch AUTOMATION_FAILURE notification:', error);
    });
    return { booked: false, reason: 'token_invalid' };
  }

  const startAt = new Date(input.startDateTimeIso);
  if (Number.isNaN(startAt.getTime())) {
    return { booked: false, reason: 'invalid_start_time' };
  }
  // The immediate (autonomy level 3+) path only ever proposes a real future
  // time, but this same function is also called from the approval-executor
  // path once an operator finally approves a level 1-2 agent's request -
  // and approval has no deadline. A request sitting in the queue long
  // enough for its own proposed time to pass would otherwise still create a
  // real Calendar event and send the customer an invite for a moment
  // that's already gone. A minute of grace covers ordinary processing
  // delay without accepting a request that's genuinely stale.
  if (startAt.getTime() < Date.now() - 60_000) {
    return { booked: false, reason: 'start_time_already_passed' };
  }
  const durationMinutes = input.durationMinutes && input.durationMinutes > 0 ? input.durationMinutes : 30;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

  const result = await createMeetingEvent({
    accessToken,
    title: input.title,
    startAt,
    endAt,
    timezone: input.businessTimezone,
    attendeeEmail: input.attendeeEmail,
  });

  if (result.status === 'error') {
    console.error(`[bookGoogleMeeting] schedule_google_meet failed for chat ${input.chatId}:`, result.reason);
    return { booked: false, reason: 'calendar_api_error', detail: result.reason };
  }

  try {
    await scheduledMeetingsRepository.createMeeting({
      provider: 'google_meet',
      googleConnectionId: connection.id,
      businessId: input.businessId,
      chatId: input.chatId,
      contactId: input.contactId,
      agentId: input.agentId,
      title: input.title,
      startAt,
      endAt,
      timezone: input.businessTimezone,
      attendeeEmail: input.attendeeEmail,
      externalEventId: result.externalEventId,
      meetUrl: result.meetUrl,
      calendarHtmlLink: result.calendarHtmlLink,
    });
  } catch (error) {
    // The real Calendar event and invite already went out - a failure to
    // record it locally must not make the tool claim the booking failed.
    console.error(
      `[bookGoogleMeeting] Calendar event ${result.externalEventId} created but failed to persist scheduled_meetings row for chat ${input.chatId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return { booked: true, meetUrl: result.meetUrl, startAt: startAt.toISOString(), title: input.title };
}
