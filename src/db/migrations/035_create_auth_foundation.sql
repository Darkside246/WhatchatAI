-- Phase B1: the real multi-user identity foundation. Every prior phase ran
-- on an implicit single bootstrapped business (see businessRepository.
-- ensureDefault) with no concept of a signed-in user at all - this is the
-- confirmed largest gap from the Chatwoot capability audit
-- (docs/reference/chatwoot-whatchatai-capability-gap.md, section 6) and the
-- real blocker for Teams, Notifications, Permissions, and Marketing
-- collaboration.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  email_verified_at TIMESTAMPTZ,
  -- Argon2id, same OWASP-minimum parameter floor already enforced for the
  -- screen-lock PIN (securityLockService.ts). Never a plaintext password,
  -- never a reversible cipher.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_params JSONB NOT NULL,
  display_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  avatar_url TEXT,
  phone_number TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- A user's membership in a business, with a real enforced role. The first
-- user ever registered for a business becomes OWNER; every subsequent
-- member is created by an existing OWNER/ADMIN via POST /workspace/members
-- (no open self-registration into an existing tenant - see authService.ts).
CREATE TABLE business_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MANAGER', 'SUPERVISOR', 'AGENT', 'MARKETING', 'VIEWER')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  invited_by UUID REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);

CREATE INDEX idx_business_memberships_user ON business_memberships (user_id);
CREATE INDEX idx_business_memberships_business ON business_memberships (business_id);

-- A real, persistent, revocable session per signed-in device - not a
-- stateless JWT (which can't be individually revoked before its own
-- expiry, the exact "sign out this device" capability the directive
-- requires).
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- SHA-256 of the opaque bearer token actually held by the browser (in an
  -- HttpOnly cookie) - the raw token itself is never persisted, mirroring
  -- how no plaintext password is ever persisted either.
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_address TEXT,
  user_agent TEXT,
  device_name TEXT,
  auth_method TEXT NOT NULL DEFAULT 'password'
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);

CREATE TABLE user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'sleek',
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  notification_sound BOOLEAN NOT NULL DEFAULT true,
  desktop_notifications BOOLEAN NOT NULL DEFAULT false,
  push_notifications BOOLEAN NOT NULL DEFAULT false,
  handoff_sound BOOLEAN NOT NULL DEFAULT true,
  reduced_motion BOOLEAN NOT NULL DEFAULT false,
  density TEXT NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  chat_font_size TEXT NOT NULL DEFAULT 'medium' CHECK (chat_font_size IN ('small', 'medium', 'large')),
  default_whatsapp_account_id UUID REFERENCES whatsapp_accounts (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real, persisted login-attempt tracking - the basis for rate limiting.
-- Deliberately keyed by email (not user_id, since a failed attempt against
-- an unknown email must still be throttleable) plus IP.
CREATE TABLE auth_login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  ip_address TEXT,
  success BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_login_attempts_email_time ON auth_login_attempts (email, created_at DESC);
