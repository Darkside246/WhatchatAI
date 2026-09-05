-- Personalisation Budget (directive §27): a real, configurable 5-level
-- Name Usage setting, replacing identityEngine.ts's previously hardcoded
-- 15-minute repetition cooldown. Same pattern as migration 952's
-- ai_actions_paused - a business-wide AI-behavior flag lives directly on
-- businesses, not a new settings table.
-- 1=Minimal, 2=Low, 3=Natural (default), 4=Frequent, 5=Very frequent.
ALTER TABLE businesses ADD COLUMN name_usage_level SMALLINT NOT NULL DEFAULT 3 CHECK (name_usage_level BETWEEN 1 AND 5);
