import type { ActionExecutor, ActionExecutionContext } from '../platform/actionBusService.js';
import type { ActionRequest } from '../../domain/platform/contracts.js';
import { bookZoomMeeting } from './bookZoomMeeting.js';

export const SCHEDULE_ZOOM_MEETING_ACTION_TYPE = 'meeting.schedule_zoom_meeting';

/** Same pattern as GoogleMeetBookingExecutor, for Zoom. */
export class ZoomMeetBookingExecutor implements ActionExecutor {
  readonly actionType = SCHEDULE_ZOOM_MEETING_ACTION_TYPE;

  async execute(
    action: ActionRequest,
    _context: ActionExecutionContext,
  ): Promise<{ status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string | undefined }> {
    const p = action.payload;
    const chatId = p.chatId;
    const businessTimezone = p.businessTimezone;
    const title = p.title;
    const startDateTimeIso = p.startDateTimeIso;
    if (typeof chatId !== 'string' || typeof businessTimezone !== 'string' || typeof title !== 'string' || typeof startDateTimeIso !== 'string') {
      return { status: 'FAILED', error: 'action payload is missing required booking fields' };
    }

    const result = await bookZoomMeeting({
      businessId: action.tenantId,
      chatId,
      contactId: typeof p.contactId === 'string' ? p.contactId : null,
      agentId: action.requestedBy.id,
      businessTimezone,
      attendeeEmail: typeof p.attendeeEmail === 'string' ? p.attendeeEmail : null,
      title,
      startDateTimeIso,
      ...(typeof p.durationMinutes === 'number' ? { durationMinutes: p.durationMinutes } : {}),
    });

    if (!result.booked) {
      return { status: 'FAILED', error: `${result.reason}${result.detail ? `: ${result.detail}` : ''}` };
    }
    return { status: 'SUCCEEDED', result: { joinUrl: result.joinUrl, startAt: result.startAt, title: result.title } };
  }
}
