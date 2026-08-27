-- Transition the original single-tenant/default business into the new
-- product-account model introduced by migration 906.
--
-- The authentication layer still bootstraps against the oldest business row,
-- while Property Operations now requires an explicit PROPERTY product account.
-- Without this bridge, an existing installation can authenticate successfully
-- and have an active OWNER membership but receives PRODUCT_ACCOUNT_REQUIRED.
--
-- This is intentionally limited to the legacy/default business boundary and
-- does not grant every business a PROPERTY account. It is idempotent and safe
-- to run after 906+.

WITH legacy_business AS (
  SELECT b.id, b.name
  FROM businesses b
  ORDER BY b.created_at ASC, b.id ASC
  LIMIT 1
),
legacy_owner AS (
  SELECT bm.business_id, bm.user_id
  FROM business_memberships bm
  JOIN legacy_business lb ON lb.id = bm.business_id
  WHERE bm.role = 'OWNER'
    AND bm.status = 'active'
  ORDER BY bm.created_at ASC, bm.user_id ASC
  LIMIT 1
),
property_product AS (
  SELECT id
  FROM product_catalog
  WHERE product_key = 'property'
    AND is_active = true
  LIMIT 1
),
created_account AS (
  INSERT INTO product_accounts (
    business_id,
    product_id,
    owner_user_id,
    status,
    display_name
  )
  SELECT
    lo.business_id,
    pp.id,
    lo.user_id,
    'ACTIVE',
    lb.name
  FROM legacy_owner lo
  JOIN legacy_business lb ON lb.id = lo.business_id
  CROSS JOIN property_product pp
  WHERE NOT EXISTS (
    SELECT 1
    FROM product_accounts pa
    WHERE pa.business_id = lo.business_id
  )
    AND NOT EXISTS (
      SELECT 1
      FROM product_accounts pa
      WHERE pa.owner_user_id = lo.user_id
        AND pa.product_id = pp.id
    )
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO product_entitlements (
  product_account_id,
  entitlement_key,
  is_enabled,
  source
)
SELECT
  pa.id,
  entitlement.entitlement_key,
  true,
  'PRODUCT'
FROM product_accounts pa
JOIN product_catalog pc
  ON pc.id = pa.product_id
CROSS JOIN LATERAL (
  VALUES
    ('property.dashboard'),
    ('property.conversations'),
    ('property.maintenance'),
    ('property.work_orders'),
    ('property.properties'),
    ('property.vendors'),
    ('property.reports')
) AS entitlement(entitlement_key)
WHERE pc.product_key = 'property'
  AND pa.business_id = (SELECT id FROM legacy_business)
ON CONFLICT (product_account_id, entitlement_key) DO NOTHING;

INSERT INTO product_account_provisioning_events (product_account_id, event_type, metadata)
SELECT
  pa.id,
  'PROVISIONED',
  jsonb_build_object('source', 'legacy_default_business_backfill', 'migration', '911')
FROM product_accounts pa
JOIN product_catalog pc ON pc.id = pa.product_id
WHERE pc.product_key = 'property'
  AND pa.business_id = (SELECT id FROM legacy_business)
  AND NOT EXISTS (
    SELECT 1
    FROM product_account_provisioning_events pae
    WHERE pae.product_account_id = pa.id
      AND pae.event_type = 'PROVISIONED'
  );
