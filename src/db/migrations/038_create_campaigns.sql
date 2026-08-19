-- Phase B5/B6: real WhatsApp broadcast campaigns. Deliberately built as a
-- thin layer over the existing, already-tested outbound-message pipeline
-- (whatsapp_outbound_messages / outboundDispatchWorker) rather than a
-- parallel send path - every campaign send is a real Baileys sendMessage,
-- tracked through the exact same queued/sending/sent/failed state machine
-- 1:1 sends already use, plus the same delivered/read lifecycle once the
-- real message row links up.
--
-- Real WhatsApp risk, not just a missing feature: Baileys sends over the
-- same personal-account protocol as a manual message - there is no
-- WhatsApp Business Platform (Cloud API) template-messaging integration in
-- this app. Recipients are therefore restricted at the database level to
-- contacts with an existing conversation (a real chat row already exists)
-- - see campaignService.ts's eligibility check - never cold outreach.
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  message_text TEXT NOT NULL,
  -- SCHEDULED is schema-ready but unused until a real scheduler exists
  -- (Phase B7, Content Calendar) - every campaign in this phase sends
  -- immediately on approval, never a fabricated "Scheduled" state.
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'REVIEW', 'APPROVED', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'PAUSED', 'CANCELLED', 'FAILED'
  )),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaigns_business ON campaigns (business_id);

-- A real, auditable snapshot of who this campaign actually targeted -
-- decided once at creation time (never a dynamically re-evaluated "all
-- contacts" list that could silently grow or shrink). Delivery status is
-- deliberately NOT duplicated here - campaignRepository joins through to
-- the real whatsapp_outbound_messages / whatsapp_messages rows for live
-- status, so there is exactly one source of truth.
CREATE TABLE campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  crm_contact_id UUID NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  outbound_message_id UUID REFERENCES whatsapp_outbound_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, crm_contact_id)
);

CREATE INDEX idx_campaign_recipients_campaign ON campaign_recipients (campaign_id);

-- The real, enforced do-not-contact flag campaigns must respect (Marketing
-- Safety: "check opt-out"). Independent of blocked/deleted status.
ALTER TABLE crm_contacts ADD COLUMN opted_out_of_campaigns BOOLEAN NOT NULL DEFAULT false;
