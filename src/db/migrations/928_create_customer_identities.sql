-- Channel-agnostic customer identity layer. Additive only: existing WhatsApp
-- identity (whatsapp_contacts, whatsapp_chats, whatsapp_jid_mappings) is
-- untouched and remains the source of truth for WhatsApp identity. This
-- layer sits above it, giving a single customer a stable UUID that
-- future channels (email, voice, WebChat) can also resolve to, without
-- requiring a rewrite of any existing chatId/contactId usage.

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customers_business_idx ON customers (business_id);

-- One row per (channel, identity) a customer is known by. Mirrors the
-- provenance/confidence philosophy already proven in whatsapp_jid_mappings:
-- never invent an identity, always record where it came from and how sure
-- we are, and let manual/verified linking outrank a transport-provided one.
CREATE TABLE customer_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  customer_id UUID NOT NULL REFERENCES customers(id),

  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email', 'voice', 'webchat')),
  -- What kind of identifier identity_value holds for this channel, e.g.
  -- 'whatsapp_contact_id' (an FK-by-value into whatsapp_contacts.id),
  -- 'phone_number', or 'email_address'. Kept as text rather than a second
  -- enum-per-channel table so a new channel never needs a migration to add
  -- its own identifier vocabulary.
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,

  source TEXT NOT NULL CHECK (source IN ('whatsapp_contact_link', 'baileys_alt_jid', 'crm_link', 'manual', 'verified')),
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'medium', 'low')),
  verified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One canonical identity value resolves to exactly one customer per tenant
-- per channel - the same invariant whatsapp_jid_mappings already enforces
-- for its own narrower (lid_jid) identity.
CREATE UNIQUE INDEX customer_identities_identity_idx
  ON customer_identities (business_id, channel, identity_type, identity_value);

CREATE INDEX customer_identities_customer_idx ON customer_identities (customer_id);

-- Backfill: every existing WhatsApp contact becomes a customer with one
-- linked identity. Additive and idempotent - re-running this migration file
-- never happens under this repo's migration runner, but the WHERE NOT
-- EXISTS guard means it is still safe if ever replayed against a database
-- that already has some (but not all) customers backfilled.
--
-- pending_contacts pre-generates each new customer's id and is referenced
-- twice below (once to populate customers, once to populate
-- customer_identities) - explicitly MATERIALIZED so gen_random_uuid() is
-- evaluated exactly once per row and both inserts agree on the same id,
-- rather than relying on row-order coincidence to pair them up.
WITH pending_contacts AS MATERIALIZED (
  SELECT wc.id AS contact_id, wc.business_id, gen_random_uuid() AS customer_id,
         COALESCE(wc.display_name, wc.push_name, wc.verified_name) AS display_name
  FROM whatsapp_contacts wc
  WHERE wc.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM customer_identities ci
      WHERE ci.business_id = wc.business_id
        AND ci.channel = 'whatsapp'
        AND ci.identity_type = 'whatsapp_contact_id'
        AND ci.identity_value = wc.id::text
    )
),
inserted_customers AS (
  INSERT INTO customers (id, business_id, display_name)
  SELECT customer_id, business_id, display_name FROM pending_contacts
  RETURNING id
)
INSERT INTO customer_identities (business_id, customer_id, channel, identity_type, identity_value, source, confidence)
SELECT business_id, customer_id, 'whatsapp', 'whatsapp_contact_id', contact_id::text, 'whatsapp_contact_link', 'high'
FROM pending_contacts;
