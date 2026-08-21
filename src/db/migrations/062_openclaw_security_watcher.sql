-- Security Watcher persistence: a real, queryable history of what the
-- watcher checked, found, and did - per the standing instruction that
-- every security decision must be recorded in PostgreSQL, not only
-- inferred from a cell's current security_status.

-- One row per (advisory, deployed version) pair actually seen. Advisories
-- are global (product-wide, not tenant-scoped) - this table is the
-- watcher's own memory of what it already evaluated for a given version,
-- so a re-run doesn't need to re-derive a classification it already made
-- (though it always re-fetches the live advisory data; this is a record
-- of the outcome, not a cache substituting for the real check).
CREATE TABLE openclaw_security_advisories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghsa_id TEXT NOT NULL,
  deployment_version TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MODERATE', 'HIGH', 'CRITICAL', 'UNKNOWN')),
  summary TEXT NOT NULL,
  advisory_url TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  -- The watcher's own conservative classification for this exact
  -- deployed version - see securityWatcherService.ts's own comment on why
  -- this is deliberately fail-closed (an unparseable or ambiguous
  -- version range never resolves to SAFE).
  risk_classification TEXT NOT NULL CHECK (risk_classification IN ('SAFE', 'WARNING', 'CRITICAL')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ghsa_id, deployment_version)
);

CREATE INDEX idx_openclaw_security_advisories_risk ON openclaw_security_advisories (risk_classification)
  WHERE risk_classification IN ('WARNING', 'CRITICAL');

-- One row per watcher run, success or failure - this is the "the watcher
-- itself failed" record the fail-closed behavior depends on: a run that
-- couldn't reach GitHub is recorded as FAILED rather than silently
-- skipped, and never quietly reinterpreted as "nothing to report."
CREATE TABLE openclaw_security_watcher_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('OK', 'FAILED')),
  versions_checked INTEGER NOT NULL DEFAULT 0,
  advisories_seen INTEGER NOT NULL DEFAULT 0,
  cells_quarantined INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
