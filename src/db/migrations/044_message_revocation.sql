-- Phase F4: real "delete for everyone" on WhatsApp, the same action the
-- phone offers, driven through Baileys' genuine { delete: WAMessageKey }
-- send.
--
-- IMPORTANT HONESTY CONSTRAINT baked into this schema. We can confirm that
-- WhatsApp ACCEPTED our revoke instruction. We cannot confirm that every
-- recipient's device actually removed the message: WhatsApp only honours
-- delete-for-everyone inside its own time window, and a recipient who is
-- offline, on an old client, or who already screenshotted it is beyond our
-- reach. So the terminal state is deliberately named 'revoke_sent', not
-- 'deleted' - it records what we truly know, and nothing more. The UI must
-- say the same.
--
-- Only our own messages can be revoked for everyone (WhatsApp's own rule);
-- that is enforced in the service, not just here.
ALTER TABLE whatsapp_messages
  ADD COLUMN revoke_status TEXT NOT NULL DEFAULT 'none'
    CHECK (revoke_status IN ('none', 'requested', 'revoke_sent', 'failed')),
  ADD COLUMN revoke_requested_at TIMESTAMPTZ,
  ADD COLUMN revoke_sent_at TIMESTAMPTZ,
  ADD COLUMN revoke_error TEXT,
  -- Who asked for it. No FK: a revoke may also be requested by an automated
  -- path (a campaign-wide recall), where there is no single acting user.
  ADD COLUMN revoke_requested_by UUID;

CREATE INDEX whatsapp_messages_revoke_status_idx
  ON whatsapp_messages (whatsapp_account_id, revoke_status)
  WHERE revoke_status <> 'none';

-- A scheduled status post that was already published can be recalled the
-- same way. Mirrors the message columns so both surfaces report the same
-- honest terminal state.
--
-- published_whatsapp_message_id is the real key WhatsApp returned when we
-- published. Without it a status simply cannot be revoked - there is
-- nothing to point the REVOKE at - so statuses published before this
-- migration keep it NULL and the UI must report them as not recallable
-- rather than pretending.
ALTER TABLE scheduled_statuses
  ADD COLUMN published_whatsapp_message_id TEXT,
  ADD COLUMN revoke_status TEXT NOT NULL DEFAULT 'none'
    CHECK (revoke_status IN ('none', 'requested', 'revoke_sent', 'failed')),
  ADD COLUMN revoke_sent_at TIMESTAMPTZ,
  ADD COLUMN revoke_error TEXT;

ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed',
  'agent_updated',
  'message_revoke_requested', 'campaign_recalled', 'status_revoke_requested'
));
