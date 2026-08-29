-- Foundation for the AI personal-assistant mode's "set a reminder" capability.
-- Deliberately its own simple table, not tied to conversation_states or any
-- specific chat - a reminder is a standing thing to notify the operator
-- about at a future time, independent of any one conversation.
CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  -- Who gets notified when this fires - normalised JID, no device suffix
  -- (see stripDeviceSuffix in whatsappConnectionService.ts for why that
  -- matters: the same real-world convention this codebase already applies
  -- to whatsapp_accounts.whatsapp_jid).
  notify_jid TEXT NOT NULL,
  message TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'CANCELLED', 'FAILED')),
  created_by_jid TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweep's own query shape: due, unsent reminders for a business, oldest
-- due first. Partial index since PENDING is the only status a sweep ever
-- searches for - SENT/CANCELLED/FAILED rows never need this index again.
CREATE INDEX idx_reminders_due ON reminders (due_at) WHERE status = 'PENDING';
CREATE INDEX idx_reminders_business ON reminders (business_id, created_at DESC);
