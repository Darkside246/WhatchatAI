-- Brand DNA: what Aura knows about the business it speaks for.
--
-- The problem this solves: an AI reply, a marketing post and a campaign all
-- currently sound like generic AI output, because nothing in the system
-- records what the business actually IS - its positioning, who it serves,
-- what makes it different, how it wants to sound. The knowledge base and
-- business documents answer "what are the facts"; nothing answered "what is
-- this brand".
--
-- PROVENANCE IS THE POINT, not a detail. Every answer records the
-- authenticated user who gave it (answered_by_user_id, NOT NULL). There is
-- deliberately no path for a WhatsApp message to write here: a customer
-- saying "you guys are the cheapest on the island" must never become a fact
-- about the business's positioning, and an owner's throwaway remark in a
-- customer thread must never become brand policy. The only writer is a
-- signed-in person on the dashboard, acting on their own business. This is
-- why answers are their own table rather than loose columns - the row IS
-- the evidence for the profile field it supports.
--
-- ENCRYPTION AT REST: every free-text answer and every synthesised profile
-- field is an AES-256-GCM envelope under this tenant's own HKDF-derived key
-- (src/security/encryption), exactly like whatsapp_messages.text_content.
-- This is commercially sensitive material - positioning, differentiators,
-- what the owner thinks competitors cannot copy - and a dump of these
-- tables without MASTER_ENCRYPTION_KEY reveals none of it. The columns that
-- stay plaintext (status, question_key, timestamps, the skipped flag) carry
-- no business content and are what the flow is driven and ordered by.
--
-- NO SENSITIVE PERSONAL DATA: the flow never asks for passwords,
-- government identifiers, banking or card details, or API keys, and the
-- service layer rejects answers that look like credentials. That is
-- enforced in code rather than here, because a CHECK constraint cannot
-- recognise a password.

CREATE TABLE IF NOT EXISTS brand_dna_profiles (
  -- One profile per business, so business_id IS the key. A second profile
  -- for the same business is not a thing that should be representable.
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,

  -- 'in_progress' while the owner is still answering, 'complete' once there
  -- is enough to synthesise a useful profile. Plaintext: it drives the flow
  -- and carries no business content.
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'complete')),

  -- The synthesised profile. Encrypted envelopes (see header).
  --
  -- Stored as separate columns rather than one JSON blob deliberately: each
  -- is independently editable by the owner, each is independently readable
  -- by a different consumer (tone_of_voice and words_to_avoid go into every
  -- AI reply; marketing_priorities and content_angles only into campaign
  -- generation), and a JSON blob would force every reader to decrypt and
  -- parse the whole profile to read one field.
  brand_identity text,
  owner_personality text,
  positioning text,
  target_customer text,
  customer_problems text,
  competitive_advantages text,
  brand_values text,
  tone_of_voice text,
  preferred_vocabulary text,
  words_to_avoid text,
  brand_personality text,
  marketing_priorities text,
  social_channels text,
  content_preferences text,
  customer_expectations text,
  local_context text,
  differentiators text,
  brand_story text,
  marketing_opportunities text,
  content_angles text,
  growth_opportunities text,

  -- When the profile was last synthesised from answers, as distinct from
  -- updated_at (which also moves when the owner edits a field by hand). The
  -- two differing is how "your answers have changed since this profile was
  -- built" is detected honestly, rather than guessed.
  synthesised_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brand_dna_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Which question this answers. A stable token ('business_what_you_sell',
  -- 'differentiator'), never the question's display text - the wording is
  -- adaptive and changes per business, so storing the prose would make two
  -- businesses' answers to the same question unjoinable.
  question_key text NOT NULL,

  -- The exact question actually put to this owner, encrypted. Kept because
  -- an adaptive follow-up ("what makes your poultry different from what
  -- customers normally find in Barbados?") is not reconstructible from
  -- question_key alone, and an answer read without its question is easy to
  -- misinterpret when the profile is later re-synthesised.
  question_text text,

  -- The owner's answer, encrypted. NULL when skipped - a skip is recorded
  -- rather than dropped, so the flow does not re-ask something already
  -- declined and the owner is never punished for skipping.
  answer_text text,
  skipped boolean NOT NULL DEFAULT false,

  -- PROVENANCE (see header). NOT NULL, and always a real dashboard user:
  -- there is no code path that writes this row from an inbound message.
  answered_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The flow reads "every answer for this business, oldest first" to decide
-- what to ask next, and synthesis reads the same set.
CREATE INDEX IF NOT EXISTS brand_dna_answers_business_created_idx
  ON brand_dna_answers (business_id, created_at);

-- One answer per question per business: re-answering updates in place
-- rather than appending a second, contradictory row that synthesis would
-- then have to arbitrate between.
CREATE UNIQUE INDEX IF NOT EXISTS brand_dna_answers_business_question_idx
  ON brand_dna_answers (business_id, question_key);

ALTER TABLE brand_dna_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON brand_dna_profiles;
CREATE POLICY tenant_isolation ON brand_dna_profiles
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

ALTER TABLE brand_dna_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON brand_dna_answers;
CREATE POLICY tenant_isolation ON brand_dna_answers
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- Same grant the other tenant tables carry (944 created this role; every
-- 10xx table since has granted to it explicitly rather than relying on
-- table ownership).
GRANT SELECT, INSERT, UPDATE, DELETE ON brand_dna_profiles TO whatchatai_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON brand_dna_answers TO whatchatai_tenant;
