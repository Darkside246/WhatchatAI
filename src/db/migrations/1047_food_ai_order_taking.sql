-- Who takes the order: the assistant, or a person.
--
-- The agent has been able to read the menu, quote a price and place an
-- order into the kitchen since the food vertical was built. What it has
-- never had is a switch. The tools were attached to the agent whenever the
-- business happened to have a menu row - so the answer to "where do I set
-- up the AI to take my orders?" was "you don't, it already does", which is
-- both surprising and impossible to turn off for an owner who wants to
-- answer the phone themselves on a Saturday night.
--
-- Three settings rather than a checkbox, because "can the robot take an
-- order" is genuinely three different questions for a kitchen:
--
--   FULL       it answers, prices it, and sends it to the kitchen.
--   QUOTE_ONLY it answers menu and price questions, and hands over to a
--              person to actually place the order. The common shape for a
--              business that wants help with the questions but wants a
--              human eye on every ticket.
--   OFF        it never touches the menu at all.
--
-- FULL is the default because FULL is what every existing business already
-- has. A migration that quietly switched a working ordering line off over
-- a weekend would be the worse mistake by a distance; the screen says what
-- the setting is, so nobody has to infer it.

ALTER TABLE food_settings
  ADD COLUMN IF NOT EXISTS ai_order_taking TEXT NOT NULL DEFAULT 'FULL';

ALTER TABLE food_settings
  DROP CONSTRAINT IF EXISTS food_settings_ai_order_taking_check;
ALTER TABLE food_settings
  ADD CONSTRAINT food_settings_ai_order_taking_check
  CHECK (ai_order_taking IN ('OFF', 'QUOTE_ONLY', 'FULL'));
