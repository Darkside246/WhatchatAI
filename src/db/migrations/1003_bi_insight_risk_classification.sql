-- Business Intelligence Agent: real risk-level classification +
-- recurring-issue tracking. bi_insights gains a denormalized product/topic
-- headline (so the Trends UI can show a real product name instead of only
-- prose), a risk level (informational only - the quality gate does not
-- cross-check it, since nothing in a candidate insight claims a risk level
-- for it to verify against), and a consecutive-periods streak count.
--
-- risk_level is null whenever the underlying trend's sentiment isn't
-- negative - risk is a concept for negative trends specifically, matching
-- the real-world example this feature was built from ("Negative mentions
-- +37%... Risk MEDIUM -> HIGH").

ALTER TABLE bi_insights
  ADD COLUMN product              TEXT,
  ADD COLUMN topic                TEXT,
  ADD COLUMN risk_level           TEXT CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  ADD COLUMN consecutive_periods  INTEGER NOT NULL DEFAULT 1;
