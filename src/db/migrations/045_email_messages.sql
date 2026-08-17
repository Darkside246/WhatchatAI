-- Phase F5: real outbound email, on a strict draft -> human approval -> send
-- path.
--
-- GOVERNING SAFETY DECISION, enforced by this schema and by emailService:
-- an AI-drafted email can NEVER reach a customer without a person holding
-- 'email.send' approving it. Agents are routed untrusted text typed by
-- strangers on WhatsApp; letting that text trigger an unattended email to a
-- real customer is the exact AI-tool-use risk recorded in the Phase C audit.
-- The approval columns are therefore NOT optional metadata - status can only
-- become 'approved' with a real approved_by, and only an approved row is
-- ever queued for sending.
--
-- Note on what is deliberately NOT here: invoice/receipt LINE ITEMS. This
-- app holds no orders or invoicing data model, so an AI asked to "write an
-- invoice" would have to invent amounts and invoice numbers. Rather than
-- fabricate, kind is recorded and the body carries only real data the
-- drafter was actually given. Real itemised invoices need a real billing
-- model first.

-- Per-business sender identity. Domain verification happens at the provider
-- (Resend/SES/Postmark), never here - so this records what the operator
-- claims, and sending simply fails honestly if the provider rejects it.
CREATE TABLE business_email_settings (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  from_email TEXT NOT NULL,
  from_name TEXT,
  reply_to_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Real provenance. A draft may originate from a person or from an agent
  -- replying in a real chat; both are recorded rather than inferred.
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  drafted_by_agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  chat_id UUID REFERENCES whatsapp_chats(id) ON DELETE SET NULL,
  crm_contact_id UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,

  kind TEXT NOT NULL CHECK (kind IN ('custom', 'order_update', 'appointment', 'receipt', 'invoice', 'general_update')),
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'failed', 'cancelled')),

  -- Approval is the security boundary, not a UI nicety.
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,

  sent_at TIMESTAMPTZ,
  provider TEXT,
  provider_message_id TEXT,
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A row cannot claim approval without recording who approved it, and
  -- cannot sit in a post-approval state unapproved. This is belt-and-braces
  -- with the service check: a bug there still cannot produce a sent email
  -- that nobody approved.
  CONSTRAINT email_approved_has_approver CHECK (
    (status IN ('approved', 'sending', 'sent') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR status IN ('draft', 'failed', 'cancelled')
  )
);

CREATE INDEX email_messages_business_status_idx ON email_messages (business_id, status, created_at DESC);
CREATE INDEX email_messages_chat_idx ON email_messages (chat_id) WHERE chat_id IS NOT NULL;

ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed',
  'agent_updated',
  'message_revoke_requested', 'campaign_recalled', 'status_revoke_requested',
  'email_drafted', 'email_approved', 'email_sent', 'email_cancelled', 'email_settings_updated'
));
