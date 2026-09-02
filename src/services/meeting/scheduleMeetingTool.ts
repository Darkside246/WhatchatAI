import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const SCHEDULE_MEETING_TOOL_NAME = 'schedule_google_meet';

/**
 * The one SEND-tier tool given to the customer-facing conversation agent -
 * it creates a real Google Calendar event with a Meet link and emails a
 * real invite to the customer, a genuine externally-visible side effect,
 * not an internal write. Its execution (executeOneToolCall in
 * aiReplyService.ts) never fabricates a booking: no Google connection, an
 * expired/revoked token, or a failed Calendar API call all return an
 * honest { booked: false, reason } the model must relay truthfully,
 * exactly like update_conversation_memory's own honest failure shape.
 */
export const scheduleMeetingFunctionDeclaration: FunctionDeclaration = {
  name: SCHEDULE_MEETING_TOOL_NAME,
  description:
    'Books a real Google Calendar event with a Google Meet video link and sends a real calendar invite email to ' +
    'the customer. Only call this once the customer has clearly agreed to a specific date and time and you have a ' +
    'real email address to send the invite to - never call this speculatively or before both are confirmed. If the ' +
    'customer has not given an email address yet, ask for one first instead of calling this tool. Use ' +
    'get_current_time first to resolve any relative date/time ("tomorrow", "next Monday") into a real date before ' +
    'calling this. If this business has not connected a Google account, this tool returns a not_connected result - ' +
    'tell the customer honestly that meeting booking is not available right now rather than claiming a meeting was ' +
    'booked. Never tell the customer a meeting was booked unless this tool actually returned booked: true.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      attendeeEmail: {
        type: Type.STRING,
        description: "The customer's real email address to send the calendar invite to. Required.",
      },
      title: {
        type: Type.STRING,
        description: 'A short, plain title for the meeting, e.g. "Consultation with Jane".',
      },
      startDateTimeIso: {
        type: Type.STRING,
        description: 'The meeting start time as an ISO 8601 datetime, resolved using get_current_time first for any relative date/time.',
      },
      durationMinutes: {
        type: Type.NUMBER,
        description: 'Meeting length in minutes. Default to 30 if the customer did not specify.',
      },
    },
    required: ['attendeeEmail', 'title', 'startDateTimeIso'],
  },
};

export interface ScheduleMeetingToolArgs {
  attendeeEmail: string;
  title: string;
  startDateTimeIso: string;
  durationMinutes?: number;
}
