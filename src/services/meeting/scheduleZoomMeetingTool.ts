import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const SCHEDULE_ZOOM_MEETING_TOOL_NAME = 'schedule_zoom_meeting';

/**
 * Sibling to scheduleMeetingTool.ts's schedule_google_meet - same SEND-tier
 * honest-failure contract (no Zoom connection, an expired/revoked token, or
 * a failed Zoom API call all return { booked: false, reason }, never a
 * fabricated booking). The one real, deliberate difference: attendeeEmail
 * is optional here, not required - Zoom has no calendar-invite mechanism,
 * so the join_url is delivered directly in this WhatsApp reply, not by
 * email. Only offered to the model when this business actually has a Zoom
 * connection (see aiReplyService.ts's buildReplyTools).
 */
export const scheduleZoomMeetingFunctionDeclaration: FunctionDeclaration = {
  name: SCHEDULE_ZOOM_MEETING_TOOL_NAME,
  description:
    'Books a real Zoom meeting and returns a real join link to send the customer directly in this chat. Only call ' +
    'this once the customer has clearly agreed to a specific date and time - never call this speculatively or ' +
    'before that is confirmed. Use get_current_time first to resolve any relative date/time ("tomorrow", "next ' +
    'Monday") into a real date before calling this. Unlike a calendar invite, Zoom delivers the join link directly ' +
    'in this chat, not by email - only ask for the customer\'s email if they offer one; it is not required. If this ' +
    'business has not connected a Zoom account, this tool returns a not_connected result - tell the customer ' +
    'honestly that meeting booking is not available right now rather than claiming a meeting was booked. If this ' +
    'tool returns reason: pending_approval, a team member needs to confirm it first - tell the customer you are ' +
    'checking and will confirm shortly, not that it failed. Never tell the customer a meeting was booked unless ' +
    'this tool actually returned booked: true.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: {
        type: Type.STRING,
        description: 'A short, plain title/topic for the meeting, e.g. "Consultation with Jane".',
      },
      startDateTimeIso: {
        type: Type.STRING,
        description: 'The meeting start time as an ISO 8601 datetime, resolved using get_current_time first for any relative date/time.',
      },
      durationMinutes: {
        type: Type.NUMBER,
        description: 'Meeting length in minutes. Default to 30 if the customer did not specify.',
      },
      attendeeEmail: {
        type: Type.STRING,
        description: "Optional - the customer's email, only if they've offered one, kept for record-keeping. Not required: Zoom delivers the join link directly in this chat.",
      },
    },
    required: ['title', 'startDateTimeIso'],
  },
};

export interface ScheduleZoomMeetingToolArgs {
  title: string;
  startDateTimeIso: string;
  durationMinutes?: number;
  attendeeEmail?: string;
}
