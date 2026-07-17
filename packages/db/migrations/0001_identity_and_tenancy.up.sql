-- 0001: identity and tenancy
-- UUID primary keys, timestamptz everywhere, numeric(14,6) for money.

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  workos_organization_id text UNIQUE NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  default_timezone text NOT NULL,
  loaded_hourly_rate_usd numeric(14, 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  workos_user_id text UNIQUE NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('member', 'manager', 'org_admin', 'security_admin', 'billing_admin')),
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  device_public_id uuid NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  observer_version text NOT NULL,
  capabilities jsonb NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, device_public_id)
);

CREATE TABLE desktop_auth_transactions (
  id uuid PRIMARY KEY,
  device_public_id uuid NOT NULL,
  state_sha256 text UNIQUE NOT NULL,
  pkce_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  organization_id uuid REFERENCES organizations (id),
  user_id uuid REFERENCES users (id),
  authorization_code_sha256 text UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'authenticated', 'exchanged', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  token_family_id uuid NOT NULL,
  refresh_token_sha256 text UNIQUE NOT NULL,
  rotated_from_session_id uuid,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tenant isolation: RLS with FORCE so even the table owner is subject to policies.
-- Sessions must SET LOCAL app.organization_id inside every tenant transaction.

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON devices
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_sessions
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

CREATE INDEX idx_devices_org_owner ON devices (organization_id, owner_user_id);
CREATE INDEX idx_device_sessions_org_user ON device_sessions (organization_id, user_id);
CREATE INDEX idx_desktop_auth_tx_expiry ON desktop_auth_transactions (status, expires_at);
