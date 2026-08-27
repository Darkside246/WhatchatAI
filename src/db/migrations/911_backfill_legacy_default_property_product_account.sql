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

DO $$
DECLARE
  legacy_business_id UUID;
  legacy_business_name TEXT;
  legacy_owner_id UUID;
  property_product_id UUID;
  property_account_id UUID;
BEGIN
  SELECT b.id, b.name
    INTO legacy_business_id, legacy_business_name
  FROM businesses b
  ORDER BY b.created_at ASC, b.id ASC
  LIMIT 1;

  IF legacy_business_id IS NULL THEN
    RETURN;
  END IF;

  SELECT bm.user_id
    INTO legacy_owner_id
  FROM business_memberships bm
  WHERE bm.business_id = legacy_business_id
    AND bm.role = 'OWNER'
    AND bm.status = 'active'
  ORDER BY bm.created_at ASC, bm.user_id ASC
  LIMIT 1;

  IF legacy_owner_id IS NULL THEN
    RETURN;
  END IF;

  SELECT pc.id
    INTO property_product_id
  FROM product_catalog pc
  WHERE pc.product_key = 'property'
    AND pc.is_active = true
  LIMIT 1;

  IF property_product_id IS NULL THEN
    RETURN;
  END IF;

  SELECT pa.id
    INTO property_account_id
  FROM product_accounts pa
  WHERE pa.business_id = legacy_business_id
    AND pa.product_id = property_product_id
  LIMIT 1;

  IF property_account_id IS NULL THEN
    -- The product-account model gives each product account its own business
    -- boundary. Only the legacy default business is bridged here.
    SELECT pa.id
      INTO property_account_id
    FROM product_accounts pa
    WHERE pa.business_id = legacy_business_id
    LIMIT 1;

    IF property_account_id IS NOT NULL THEN
      -- A different product already owns the legacy business boundary, so do
      -- not bypass the one-business-per-product-account invariant.
      RETURN;
    END IF;

    INSERT INTO product_accounts (
      business_id,
      product_id,
      owner_user_id,
      status,
      display_name
    )
    VALUES (
      legacy_business_id,
      property_product_id,
      legacy_owner_id,
      'ACTIVE',
      legacy_business_name
    )
    RETURNING id INTO property_account_id;
  ELSE
    -- Repair an account created during an interrupted/partial migration.
    UPDATE product_accounts
       SET owner_user_id = COALESCE(owner_user_id, legacy_owner_id),
           status = CASE WHEN status = 'PROVISIONING' THEN 'ACTIVE' ELSE status END,
           display_name = COALESCE(NULLIF(display_name, ''), legacy_business_name),
           updated_at = now()
     WHERE id = property_account_id;
  END IF;

  INSERT INTO product_entitlements (
    product_account_id,
    entitlement_key,
    is_enabled,
    source
  )
  VALUES
    (property_account_id, 'property.dashboard', true, 'PRODUCT'),
    (property_account_id, 'property.conversations', true, 'PRODUCT'),
    (property_account_id, 'property.maintenance', true, 'PRODUCT'),
    (property_account_id, 'property.work_orders', true, 'PRODUCT'),
    (property_account_id, 'property.properties', true, 'PRODUCT'),
    (property_account_id, 'property.vendors', true, 'PRODUCT'),
    (property_account_id, 'property.reports', true, 'PRODUCT')
  ON CONFLICT (product_account_id, entitlement_key) DO NOTHING;

  INSERT INTO product_account_provisioning_events (
    product_account_id,
    event_type,
    metadata
  )
  SELECT
    property_account_id,
    'PROVISIONED',
    jsonb_build_object(
      'source', 'legacy_default_business_backfill',
      'migration', '911'
    )
  WHERE NOT EXISTS (
    SELECT 1
    FROM product_account_provisioning_events pae
    WHERE pae.product_account_id = property_account_id
      AND pae.event_type = 'PROVISIONED'
  );
END $$;
