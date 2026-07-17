-- 0004: policies, budgets, connectors, pricing, ROI, audit chain

CREATE TABLE policy_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  version_number integer NOT NULL,
  policy jsonb NOT NULL,
  sha256 text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, version_number)
);

CREATE TABLE usage_reservations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  run_id uuid UNIQUE NOT NULL REFERENCES agent_runs (id),
  reserved_cost_usd numeric(14, 6) NOT NULL,
  reserved_record_reads integer NOT NULL,
  reserved_record_writes integer NOT NULL,
  consumed_cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('active', 'released', 'consumed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Global price tables: not tenant data; effective-dated, never hardcoded in logic.
CREATE TABLE provider_price_versions (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  model_or_service text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  unit text NOT NULL,
  input_price_usd numeric(18, 9),
  output_price_usd numeric(18, 9),
  flat_price_usd numeric(18, 9),
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model_or_service, effective_from)
);

CREATE TABLE connector_accounts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid REFERENCES users (id),
  provider text NOT NULL,
  external_account_id_hash text NOT NULL,
  display_label text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('connected', 'degraded', 'revoked')),
  encrypted_token_ciphertext bytea NOT NULL,
  encrypted_data_key bytea NOT NULL,
  token_key_version integer NOT NULL,
  expires_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, external_account_id_hash)
);

CREATE TABLE roi_baselines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  pattern_id uuid NOT NULL REFERENCES patterns (id),
  median_manual_duration_ms bigint NOT NULL,
  occurrence_count integer NOT NULL,
  confidence numeric(6, 5) NOT NULL,
  user_confirmed boolean NOT NULL DEFAULT false,
  measured_from timestamptz NOT NULL,
  measured_to timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roi_measurements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  agent_id uuid NOT NULL REFERENCES agents (id),
  run_id uuid UNIQUE NOT NULL REFERENCES agent_runs (id),
  baseline_ms bigint NOT NULL,
  automated_human_ms bigint NOT NULL,
  intervention_ms bigint NOT NULL,
  verified_saved_ms bigint NOT NULL,
  gross_value_usd numeric(14, 6),
  model_cost_usd numeric(14, 6) NOT NULL,
  connector_cost_usd numeric(14, 6) NOT NULL,
  infrastructure_cost_usd numeric(14, 6) NOT NULL,
  net_value_usd numeric(14, 6),
  verification_status text NOT NULL CHECK (verification_status IN ('projected', 'verified', 'disputed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit chain, hash-linked per organization.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'device', 'service', 'system')),
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  reason_code text,
  metadata jsonb NOT NULL,
  request_id text,
  occurred_at timestamptz NOT NULL,
  previous_event_hash text,
  event_hash text NOT NULL
);

CREATE TABLE audit_chain_heads (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id),
  latest_event_id uuid,
  latest_event_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy_versions
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_reservations
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE connector_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_accounts
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE roi_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE roi_baselines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roi_baselines
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE roi_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE roi_measurements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roi_measurements
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_chain_heads
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

CREATE INDEX idx_audit_org_occurred ON audit_events (organization_id, occurred_at DESC);
CREATE INDEX idx_connector_accounts_org_provider ON connector_accounts (organization_id, provider);
CREATE INDEX idx_roi_measurements_org_agent ON roi_measurements (organization_id, agent_id);
CREATE INDEX idx_price_versions_lookup ON provider_price_versions (provider, model_or_service, effective_from DESC);
