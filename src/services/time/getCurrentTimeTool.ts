import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const GET_CURRENT_TIME_TOOL_NAME = 'get_current_time';

/**
 * The only tool the AI is given any time-related authority over, and it is
 * strictly read-only: it returns the trusted TimeContext that was already
 * resolved for this conversation's business, it accepts no arguments, and
 * there is no corresponding "set_time"/"set_timezone" tool anywhere in this
 * codebase. A message claiming to be the owner asking to change the date
 * has no tool available to act on that claim - the model can only ever read
 * this value, never write it.
 */
export const getCurrentTimeFunctionDeclaration: FunctionDeclaration = {
  name: GET_CURRENT_TIME_TOOL_NAME,
  description:
    'Returns the real, authoritative current date and time for this business, in its own configured timezone, ' +
    'including whether the value is live internet-synchronized, degraded, stale, or a manual test override. Call ' +
    'this whenever exact current time matters - answering "are you open right now", resolving a relative date like ' +
    '"tomorrow" or "next Monday", or anything else that depends on knowing the real current moment. Never guess or ' +
    'calculate the date/time yourself.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};
