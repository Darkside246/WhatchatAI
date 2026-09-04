-- Section 20 (cross-conversation preferred-name carry-over, "personalisation
-- budget"): conversation_states.preferred_name (Section 15 Tier 2 evidence)
-- only ever lived on the one conversation the customer stated it in - a
-- returning customer in a brand-new conversation had to tell AURA their
-- preferred name all over again. customer_memory (migration 959, Layer 2
-- "layered memory") already carries confirmedFacts cross-conversation for
-- exactly this reason; preferred_name gets the same treatment.
ALTER TABLE customer_memory ADD COLUMN preferred_name TEXT;
