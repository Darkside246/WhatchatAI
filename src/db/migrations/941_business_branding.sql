-- Business-level branding: one accent color applied across the whole
-- dashboard UI (via the app's existing --color-accent design token) plus
-- invoice/document headers, and one logo shown in the same two places.
-- Stored directly on businesses, matching this table's existing
-- columns-not-a-side-table convention (time_source/manual_override_*,
-- deletion_requested_at).
ALTER TABLE businesses
  ADD COLUMN brand_color TEXT,
  ADD COLUMN logo_data_url TEXT;

-- logo_data_url is a data: URI (validated + size-capped at the application
-- layer in workspaceService.ts) - small enough that storing it inline needs
-- no new media-storage plumbing, and it renders instantly with no extra
-- authenticated fetch on either the dashboard or a generated invoice.
ALTER TABLE businesses
  ADD CONSTRAINT businesses_brand_color_format
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$');
