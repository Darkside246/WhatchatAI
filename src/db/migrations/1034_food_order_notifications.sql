-- Phase 5: telling the customer as their order moves.
--
-- Tied to deterministic stage transitions, never to an AI's judgement. The
-- kitchen bumping a ticket is what makes an order ready - not a model
-- deciding it probably is by now - so the notification engine reads the
-- state machine and nothing else.
--
-- Additive only. No existing core table is touched.

ALTER TABLE food_settings
  /* How much a business wants to say.
     STANDARD by default: the milestones a customer genuinely wants
     (received, paid, cooking, ready) and none of the ones that only
     produce noise. A business that wants fewer or more says so. */
  ADD COLUMN IF NOT EXISTS notification_verbosity TEXT NOT NULL DEFAULT 'STANDARD',

  /* Per-event switches and wording, only consulted under CUSTOM.
     JSONB because it is read and written whole, by one screen, and an
     operator editing their messages wants one save - not six rows. */
  ADD COLUMN IF NOT EXISTS notification_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE food_settings
  DROP CONSTRAINT IF EXISTS food_settings_notification_verbosity_check;
ALTER TABLE food_settings
  ADD CONSTRAINT food_settings_notification_verbosity_check
  CHECK (notification_verbosity IN ('MINIMAL', 'STANDARD', 'DETAILED', 'CUSTOM'));

/* What has already been said about each order.
   A kitchen sends a ticket back to the line and bumps it again - that is
   normal, and it must not tell the customer twice that cooking has
   started. The unique index is the guarantee; a check in code alone would
   still race two workers.
   Rows rather than a flag set on the order because "when were they told"
   is a real question when somebody complains they heard nothing. */
CREATE TABLE IF NOT EXISTS food_order_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,

  event TEXT NOT NULL,
  /* The message as it actually went out, so an operator can see what their
     customer really read rather than re-render a template that may since
     have been edited. */
  body TEXT NOT NULL,
  /* The outbound row this became, when one was created. Null when the send
     itself failed - the attempt is still recorded, because a notification
     that was tried and failed is exactly what somebody needs to see. */
  outbound_message_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES food_orders (business_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS food_order_notifications_once_idx
  ON food_order_notifications (business_id, order_id, event);

GRANT SELECT, INSERT, UPDATE, DELETE ON food_order_notifications TO whatchatai_tenant;
ALTER TABLE food_order_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON food_order_notifications;
CREATE POLICY tenant_isolation ON food_order_notifications
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
