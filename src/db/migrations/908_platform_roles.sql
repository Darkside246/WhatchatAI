-- Platform-level role is deliberately separate from business membership roles.
-- A client can only see product accounts they own/belong to. DEVELOPER is the
-- sole cross-platform control-plane role and is granted explicitly server-side.

ALTER TABLE users
  ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'CLIENT'
  CHECK (platform_role IN ('CLIENT', 'DEVELOPER'));

CREATE INDEX idx_users_platform_role ON users (platform_role);
