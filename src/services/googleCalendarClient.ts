/**
 * Real Google Calendar API calls - creating an event with a Meet link and
 * a real attendee invite. Separate from googleMeetingOAuthService.ts
 * (that file owns the OAuth token lifecycle; this one owns what actually
 * gets done with a valid access token).
 */
import { randomUUID } from 'node:crypto';

interface CreateMeetingEventInput {
  accessToken: string;
  title: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  attendeeEmail: string;
}

interface CalendarEntryPoint {
  entryPointType?: string;
  uri?: string;
}

interface CalendarEventResponse {
  id?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: CalendarEntryPoint[] };
}

export type CreateMeetingEventResult =
  | { status: 'created'; externalEventId: string; meetUrl: string; calendarHtmlLink: string | null }
  | { status: 'error'; reason: string };

/**
 * conferenceDataVersion=1 is required in the query string - omitted,
 * Google silently drops conferenceData and creates a plain event with no
 * Meet link, no error. sendUpdates=all is required too - the default
 * ('none') creates the event but never emails the attendee, which would
 * defeat the entire point of "sends a real calendar invite."
 */
export async function createMeetingEvent(input: CreateMeetingEventInput): Promise<CreateMeetingEventResult> {
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all';

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        summary: input.title,
        start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
        end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
        attendees: [{ email: input.attendeeEmail }],
        conferenceData: {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
    });
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { status: 'error', reason: `Google Calendar API returned ${resp.status}: ${body}` };
  }

  const event = (await resp.json()) as CalendarEventResponse;
  if (!event.id) return { status: 'error', reason: 'Google Calendar API response had no event id.' };

  // Calendar can return multiple entry point types (video/phone/more) -
  // the real Meet URL is specifically the 'video' one, never entryPoints[0].
  const videoEntry = event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video');
  if (!videoEntry?.uri) return { status: 'error', reason: 'Google Calendar API did not return a Meet video link.' };

  return {
    status: 'created',
    externalEventId: event.id,
    meetUrl: videoEntry.uri,
    calendarHtmlLink: event.htmlLink ?? null,
  };
}
