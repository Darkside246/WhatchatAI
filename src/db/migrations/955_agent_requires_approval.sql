-- A real, simple "ask before acting" toggle per agent - deliberately a
-- single boolean, not a graduated 0-5 autonomy ladder (a decision already
-- made explicitly earlier in this project: "simple per-tool toggles, not
-- a 5-level autonomy ladder"). When true, any SEND-tier tool call
-- (currently schedule_google_meet/schedule_zoom_meeting) creates a real
-- pending action in the existing platform_action_requests/approval queue
-- instead of executing immediately - see aiReplyService.ts's
-- createPendingMeetingApproval and the GoogleMeetBookingExecutor/
-- ZoomMeetBookingExecutor that dispatch it once approved.
ALTER TABLE ai_agents ADD COLUMN requires_approval_for_actions BOOLEAN NOT NULL DEFAULT false;
