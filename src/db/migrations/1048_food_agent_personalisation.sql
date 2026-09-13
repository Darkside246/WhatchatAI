-- Making the ordering assistant this business's, not a generic one.
--
-- Every food business is different in ways no menu can express. One does
-- not do substitutions. One needs an hour's notice on anything from the
-- grill. One has a minimum for delivery that is not a number in a zone
-- table but a sentence a person says. Until now the agent knew the dishes
-- and the prices and nothing else, so it filled those gaps the way a model
-- fills gaps: plausibly, and sometimes wrongly, on the business's behalf.
--
-- Two fields, deliberately, rather than a form nobody finishes.
--
-- order_taking_instructions is free text in the owner's own words, passed
-- to the agent verbatim. It is open-ended on purpose: the whole point is
-- that the differences between kitchens cannot be enumerated in advance,
-- and a text box an owner actually fills in beats twelve checkboxes they
-- do not.
--
-- typical_prep_minutes is a number because "how long will it be?" is the
-- most asked question in food service and the agent had no honest answer
-- to it. Nullable: a kitchen that has not said must not have a time
-- invented for it, and the agent is told to say it will check rather than
-- guess. This is NOT the SLA columns above - those are the timer on the
-- kitchen board, which is the business watching itself. This is what a
-- customer is told.
--
-- Neither is persona. How the assistant SOUNDS stays on the Agents page,
-- where the owner already set it once; repeating it here is how two
-- settings end up disagreeing about the same thing.

ALTER TABLE food_settings
  ADD COLUMN IF NOT EXISTS order_taking_instructions TEXT;

ALTER TABLE food_settings
  ADD COLUMN IF NOT EXISTS typical_prep_minutes INTEGER;

/* A prep time of zero is not a promise anybody can keep, and a negative one
   is a typo. Bounded at eight hours so a slip of the keyboard cannot have
   the agent quoting a fortnight. */
ALTER TABLE food_settings
  DROP CONSTRAINT IF EXISTS food_settings_typical_prep_minutes_check;
ALTER TABLE food_settings
  ADD CONSTRAINT food_settings_typical_prep_minutes_check
  CHECK (typical_prep_minutes IS NULL OR (typical_prep_minutes > 0 AND typical_prep_minutes <= 480));
