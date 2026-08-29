-- Internal operator notes on a property (the "note for [property]: [text]"
-- Operator Mode command - see operatorCommandService.ts's handlePropertyNote,
-- which previously only replied "queued" and never persisted anything).
--
-- Deliberately its own table, not an append to property_properties'
-- guest_instructions/emergency_instructions columns: those two are
-- guest-facing content surfaced to customers via PropertyContextService, and
-- an internal operator note ("pool filter needs replacing") must never leak
-- into a customer-facing field.
CREATE TABLE property_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id UUID NOT NULL,
  note TEXT NOT NULL,
  -- The operator's WhatsApp JID (from operatorCommandService's authenticated
  -- session) - not a user_id, since Operator Mode authenticates by JID/PIN,
  -- not a dashboard login.
  created_by_jid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (business_id, property_id) REFERENCES property_properties (business_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_property_notes_property ON property_notes (business_id, property_id, created_at DESC);
