-- A third eye at the pass.
--
-- A person packing forty orders on a Friday will not notice the ketchup on
-- the one burger that was ordered without it. A photograph will.
--
-- Both settings default to OFF. This is help a business opts into, not a
-- step imposed on a kitchen that never asked for one - and a kitchen that
-- is made to photograph every order will find a way not to.

ALTER TABLE food_settings
  /* Must a photo be taken before an order leaves the pass. */
  ADD COLUMN IF NOT EXISTS qc_photo_required BOOLEAN NOT NULL DEFAULT false,
  /* Is that photo actually read against the order. Separate from the
     above because the two are genuinely separate decisions: a business
     may want photos purely as its own record of what went out, and
     another may want the check only on the orders somebody chooses to
     photograph. */
  ADD COLUMN IF NOT EXISTS qc_vision_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS food_qc_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,

  /* The photo itself, through the same encrypted-at-rest store every other
     piece of media in the app uses. Kept because the value of a check
     nobody can go back and look at is mostly imaginary - a disputed order
     next week is exactly when somebody wants the picture. */
  photo_reference TEXT,
  photo_sha256 TEXT,
  photo_mime_type TEXT,

  /* What the model said it could SEE, exactly as it said it. Stored raw so
     a finding can always be traced back to the observation that produced
     it rather than to a summary of one. */
  observation JSONB NOT NULL DEFAULT '{}'::jsonb,
  /* Every finding, unverifiable ones included. The screen filters those
     out; the record does not, so the check has an honest account of
     itself. */
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  /* How many findings were actually put in front of a person. Denormalised
     so "which orders were flagged" is an index lookup rather than a scan
     through JSONB. */
  raised_count INTEGER NOT NULL DEFAULT 0,

  /* Which provider and model read it, for the same reason every other AI
     call in this app records it: a change in behaviour has to be
     attributable to something. */
  provider TEXT,
  model TEXT,

  /* Who took the photo. Null when the check ran unattended. */
  checked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  /* What the person did about it. A finding nobody acted on and a finding
     somebody looked at and dismissed are different facts. */
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledgement_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES food_orders (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS food_qc_checks_order_idx
  ON food_qc_checks (business_id, order_id, created_at DESC);

/* Finding the orders that were flagged, without reading the JSONB. */
CREATE INDEX IF NOT EXISTS food_qc_checks_raised_idx
  ON food_qc_checks (business_id, created_at DESC)
  WHERE raised_count > 0;

GRANT SELECT, INSERT, UPDATE, DELETE ON food_qc_checks TO whatchatai_tenant;

ALTER TABLE food_qc_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON food_qc_checks;
CREATE POLICY tenant_isolation ON food_qc_checks
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
