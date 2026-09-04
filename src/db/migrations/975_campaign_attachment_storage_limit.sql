-- Section 27-30 follow-up: campaign attachments had a real per-file size
-- cap (MAX_MEDIA_BYTES in campaignService.ts, 16MB) but no per-business
-- cumulative storage limit at all - a business on any plan could store an
-- unbounded number of 16MB attachments across campaigns with nothing
-- capping the total. media_size_bytes captures the real decoded byte
-- length at store time (campaignService.ts's storeCampaignAttachment
-- already computes buffer.length for the size-cap check - this just keeps
-- that real number instead of discarding it).
ALTER TABLE campaigns ADD COLUMN media_size_bytes BIGINT;

INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
SELECT id, 'max_campaign_storage_mb', 50, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'max_campaign_storage_mb', 250, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'max_campaign_storage_mb', 1000, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'max_campaign_storage_mb', NULL, true FROM plans WHERE plan_key = 'enterprise';
