import type { ActionExecutor, ActionExecutionContext } from '../platform/actionBusService.js';
import type { ActionRequest } from '../../domain/platform/contracts.js';
import { bookGoogleMeeting } from './bookGoogleMeeting.js';

export const SCHEDULE_GOOGLE_MEET_ACTION_TYPE = 'meeting.schedule_google_meet';

/**
 * Dispatches a Google Meet booking an operator just approved through the
 * real ApprovalService/ActionBus flow - only reachable for an agent at
 * autonomy level 1 or 2 (see aiReplyService.ts's
 * createPendingApprovalAction, the only place that ever persists this
 * action type). Calls the exact same bookGoogleMeeting() the immediate
 * (level 3+) path calls - one real booking implementation, two ways
 * to reach it.
 */
export class GoogleMeetBookingExecutor implements ActionExecutor {
  readonly actionType = SCHEDULE_GOOGLE_MEET_ACTION_TYPE;

  async execute(
    action: ActionRequest,
    _context: ActionExecutionContext,
  ): Promise<{ status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string | undefined }> {
    const p = action.payload;
    const chatId = p.chatId;
    const businessTimezone = p.businessTimezone;
    const title = p.title;
    const startDateTimeIso = p.startDateTimeIso;
    const attendeeEmail = p.attendeeEmail;
    if (typeof chatId !== 'string' || typeof businessTimezone !== 'string' || typeof title !== 'string' || typeof startDateTimeIso !== 'string' || typeof attendeeEmail !== 'string') {
      return { status: 'FAILED', error: 'action payload is missing required booking fields' };
    }

    const result = await bookGoogleMeeting({
      businessId: action.tenantId,
      chatId,
      contactId: typeof p.contactId === 'string' ? p.contactId : null,
      agentId: action.requestedBy.id,
      businessTimezone,
      attendeeEmail,
      title,
      startDateTimeIso,
      ...(typeof p.durationMinutes === 'number' ? { durationMinutes: p.durationMinutes } : {}),
    });

    if (!result.booked) {
      return { status: 'FAILED', error: `${result.reason}${result.detail ? `: ${result.detail}` : ''}` };
    }
    return { status: 'SUCCEEDED', result: { meetUrl: result.meetUrl, startAt: result.startAt, title: result.title } };
  }
}
