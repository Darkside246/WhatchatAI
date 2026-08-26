-- A skill may be platform-global or tenant-private. The earlier composite
-- primary key made business_id implicitly NOT NULL, which prevented global
-- skills. Replace it with a surrogate key and explicit uniqueness for scope.

ALTER TABLE platform_skills DROP CONSTRAINT IF EXISTS platform_skills_pkey;
ALTER TABLE platform_skills ADD COLUMN IF NOT EXISTS row_id UUID DEFAULT gen_random_uuid();
UPDATE platform_skills SET row_id = gen_random_uuid() WHERE row_id IS NULL;
ALTER TABLE platform_skills ALTER COLUMN row_id SET NOT NULL;
ALTER TABLE platform_skills ADD CONSTRAINT platform_skills_pkey PRIMARY KEY (row_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_skills_global ON platform_skills (id, version) WHERE business_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_skills_tenant ON platform_skills (business_id, id, version) WHERE business_id IS NOT NULL;
