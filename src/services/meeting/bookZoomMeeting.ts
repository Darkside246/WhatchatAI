import { pool } from '../../db/pool.js';
import { ZoomMeetingRepository } from '../../repositories/zoomMeetingRepository.js';
import { ScheduledMeetingsRepository } from '../../repositories/scheduledMeetingsRepository.js';
import { getValidAccessToken as getValidZoomMeetingAccessToken } from '../zoomMeetingOAuthService.js';
import { createZoomMeeting } from '../zoomMeetingClient.js';
import { notifyBusiness } from '../notificationService.js';

const zoomMeetingRepository = new ZoomMeetingRepository(pool);
const scheduledMeetingsRepository = new ScheduledMeetingsRepository(pool);

export interface BookZoomMeetingInput {
  businessId: string;
  chatId: string;
  contactId: string | null;
  agentId: string;
  businessTimezone: string;
  attendeeEmail?: string | null;
  title: string;
  startDateTimeIso: string;
  durationMinutes?: number;
}

export type BookZoomMeetingResult =
  | { booked: true; joinUrl: string; startAt: string; title: string }
  | { booked: false; reason: string; detail?: string };

/**
 * The real Zoom booking side effect - extracted verbatim from
 * aiReplyService.ts's executeOneToolCall, the same reason and pattern as
 * bookGoogleMeeting.ts's own doc comment.
 */
export async function bookZoomMeeting(input: BookZoomMeetingInput): Promise<BookZoomMeetingResult> {
  if (!input.title || !input.startDateTimeIso) {
    return { booked: false, reason: 'missing_required_fields' };
  }
  const connection = await zoomMeetingRepository.getConnectionByBusiness(input.businessId);
  if (!connection) {
    return { booked: false, reason: 'not_connected' };
  }

  const accessToken = await getValidZoomMeetingAccessToken(input.businessId);
  if (!accessToken) {
    // Same class of gap as bookGoogleMeeting.ts's identical check: a dead
    // refresh token fails identically on every future attempt with nothing
    // else in the system to ever surface it to staff.
    await notifyBusiness({
      businessId: input.businessId,
      type: 'AUTOMATION_FAILURE',
      severity: 'warning',
      title: 'Zoom needs to be reconnected',
      body: 'A booking attempt failed because the Zoom connection is no longer valid (likely revoked or expired). Reconnect it in Settings to resume booking Zoom meetings.',
      targetType: 'zoom_meeting_connection',
      targetId: connection.id,
    }).catch((error) => {
      console.error('[bookZoomMeeting] Failed to dispatch AUTOMATION_FAILURE notification:', error);
    });
    return { booked: false, reason: 'token_invalid' };
  }

  const startAt = new Date(input.startDateTimeIso);
  if (Number.isNaN(startAt.getTime())) {
    return { booked: false, reason: 'invalid_start_time' };
  }
  // Same gap as bookGoogleMeeting.ts's identical check: this function is
  // also reached from the approval-executor path, where approval has no
  // deadline - a request sitting long enough for its own proposed time to
  // pass would otherwise still create a real Zoom meeting for a moment
  // that's already gone.
  if (startAt.getTime() < Date.now() - 60_000) {
    return { booked: false, reason: 'start_time_already_passed' };
  }
  const durationMinutes = input.durationMinutes && input.durationMinutes > 0 ? input.durationMinutes : 30;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

  const result = await createZoomMeeting({
    accessToken,
    title: input.title,
    startAt,
    endAt,
    timezone: input.businessTimezone,
  });

  if (result.status === 'error') {
    console.error(`[bookZoomMeeting] schedule_zoom_meeting failed for chat ${input.chatId}:`, result.reason);
    return { booked: false, reason: 'zoom_api_error', detail: result.reason };
  }

  try {
    await scheduledMeetingsRepository.createMeeting({
      provider: 'zoom',
      zoomConnectionId: connection.id,
      businessId: input.businessId,
      chatId: input.chatId,
      contactId: input.contactId,
      agentId: input.agentId,
      title: input.title,
      startAt,
      endAt,
      timezone: input.businessTimezone,
      attendeeEmail: input.attendeeEmail ?? null,
      externalEventId: result.externalEventId,
      meetUrl: result.joinUrl,
    });
  } catch (error) {
    // The real Zoom meeting already exists - a failure to record it
    // locally must not make the tool claim the booking failed.
    console.error(
      `[bookZoomMeeting] Zoom meeting ${result.externalEventId} created but failed to persist scheduled_meetings row for chat ${input.chatId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return { booked: true, joinUrl: result.joinUrl, startAt: startAt.toISOString(), title: input.title };
}
