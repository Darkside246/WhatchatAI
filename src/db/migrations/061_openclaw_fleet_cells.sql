-- OpenClaw Fleet cell mapping (finalized architecture: one isolated Fleet
-- cell per tenant, never a shared Gateway - see docs/gateway/multi-tenant
-- -hosting.md's own statement that session IDs select routing but do not
-- authorize one tenant against another). This table is the authoritative
-- tenant_id -> fleet_cell_id -> gateway_endpoint -> deployment_version ->
-- image_digest -> security_status mapping the control plane keeps, per
-- the user's own finalized OPENCLAW FLEET REQUIREMENTS directive.
--
-- One row per business (tenant). fleet_cell_id is the Fleet tenant ID
-- passed to every `openclaw fleet` CLI invocation - validated against
-- OpenClaw's own documented tenant-ID regex before use, never derived
-- from user-controlled text directly (see openclawFleetService.ts).
CREATE TABLE openclaw_fleet_cells (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  fleet_cell_id TEXT NOT NULL UNIQUE,
  -- host loopback URL, e.g. http://127.0.0.1:19104 - never reachable
  -- outside the Fleet host itself (see fleet.md's "Host publishing" row).
  gateway_endpoint TEXT,
  -- the exact `--image` reference Fleet was told to run, e.g.
  -- ghcr.io/openclaw/openclaw@sha256:<digest> - always digest-pinned,
  -- never a moving tag like `:latest`.
  deployment_version TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  security_status TEXT NOT NULL DEFAULT 'SAFE' CHECK (security_status IN (
    'SAFE', 'WARNING', 'CRITICAL', 'SECURITY_QUARANTINED'
  )),
  -- lifecycle state as last observed from `fleet status`/`fleet doctor`,
  -- not assumed - a cell that was told to start can still be unreachable.
  cell_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (cell_state IN (
    'PENDING', 'CREATING', 'RUNNING', 'STOPPED', 'UPGRADING', 'REMOVED', 'UNHEALTHY'
  )),
  quarantine_reason TEXT,
  quarantined_at TIMESTAMPTZ,
  last_health_check_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_openclaw_fleet_cells_security_status ON openclaw_fleet_cells (security_status)
  WHERE security_status IN ('WARNING', 'CRITICAL', 'SECURITY_QUARANTINED');
