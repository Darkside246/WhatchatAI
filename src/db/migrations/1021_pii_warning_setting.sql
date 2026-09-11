-- Whether Aura warns an operator before they send a message that appears to
-- contain personal information.
--
-- WHAT THIS IS AND IS NOT. Aura sends customer messages to an AI provider in
-- order to generate a reply - that is the product and it cannot work
-- otherwise. This setting governs the part the business actually controls:
-- text a person on the BUSINESS side types, which then joins the
-- conversation history and is sent to a provider on every later turn.
--
-- It is a warning, not a block. The operator is told what was recognised and
-- decides. A hard block would be wrong - sending a customer their own phone
-- number back is often exactly right - and a tool that refuses legitimate
-- work is a tool people route around.
--
-- DEFAULT ON, unlike the channel-notification setting (1018) which defaults
-- off. The reasoning differs: 1018 adds a new class of interruption, so
-- silence was the safe default. This one prevents an irreversible
-- disclosure to a third party, so the safe default is to warn. A business
-- that finds it noisy turns it off deliberately, having seen it.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS pii_warning_enabled boolean NOT NULL DEFAULT true;
