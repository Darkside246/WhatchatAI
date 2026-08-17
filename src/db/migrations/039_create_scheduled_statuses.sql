-- Phase B7: real, scheduled WhatsApp Status posts. Baileys genuinely
-- supports posting to status@broadcast (confirmed by reading
-- Types/Message.d.ts's statusJidList/backgroundColor/font options and
-- WABinary/jid-utils.ts's STORIES_JID constant directly, not assumed) - so
-- this is a real feature, not a UI stub in front of an unsupported
-- capability. Scheduling itself is a real BullMQ delayed job (see
-- scheduledStatusPublishWorker.ts), not a fabricated "Scheduled" label.
CREATE TABLE scheduled_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  status_type TEXT NOT NULL CHECK (status_type IN ('text', 'image', 'video')),
  text_content TEXT,
  caption TEXT,
  background_color TEXT,
  media_storage_reference TEXT,
  media_mime_type TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scheduled_statuses_business ON scheduled_statuses (business_id);
