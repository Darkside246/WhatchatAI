/**
 * Real Zoom API calls - creating a scheduled meeting and getting back a
 * real join_url. Separate from zoomMeetingOAuthService.ts (that file owns
 * the OAuth token lifecycle; this one owns what actually gets done with a
 * valid access token) - mirrors googleCalendarClient.ts's split.
 */

interface CreateZoomMeetingInput {
  accessToken: string;
  title: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
}

interface ZoomMeetingResponse {
  id?: number;
  join_url?: string;
}

export type CreateZoomMeetingResult =
  | { status: 'created'; externalEventId: string; joinUrl: string }
  | { status: 'error'; reason: string };

/**
 * Unlike Google Calendar, Zoom's meeting-creation API has no
 * attendee/invite-email concept - it just returns a join_url. This is a
 * real, deliberate simplification for this product: the AI sends that
 * join_url directly in the WhatsApp reply, so WhatsApp itself is the
 * invite channel, not a separate emailed calendar invite.
 */
export async function createZoomMeeting(input: CreateZoomMeetingInput): Promise<CreateZoomMeetingResult> {
  const url = 'https://api.zoom.us/v2/users/me/meetings';
  const durationMinutes = Math.max(1, Math.round((input.endAt.getTime() - input.startAt.getTime()) / 60_000));

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        topic: input.title,
        type: 2, // scheduled meeting
        start_time: input.startAt.toISOString(),
        duration: durationMinutes,
        timezone: input.timezone,
      }),
    });
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { status: 'error', reason: `Zoom API returned ${resp.status}: ${body}` };
  }

  const meeting = (await resp.json()) as ZoomMeetingResponse;
  if (!meeting.id || !meeting.join_url) {
    return { status: 'error', reason: 'Zoom API response had no meeting id or join_url.' };
  }

  return { status: 'created', externalEventId: String(meeting.id), joinUrl: meeting.join_url };
}
