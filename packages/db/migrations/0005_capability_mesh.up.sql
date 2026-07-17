-- 0005: Desktop Capability Mesh — routes, availability, workflow objects,
-- shadow comparisons, execution receipts, permission audit.

CREATE TABLE capability_availability (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid REFERENCES users (id),
  capability_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('api', 'browser_extension', 'macos_accessibility', 'teach_mode', 'human')),
  status text NOT NULL CHECK (status IN ('available', 'unavailable', 'permission_required', 'degraded')),
  scopes text[] NOT NULL DEFAULT '{}',
  reliability_score numeric(6,5) NOT NULL DEFAULT 0.9,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, owner_user_id, capability_id, source)
);

CREATE TABLE workflow_object_refs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  provider text NOT NULL,
  object_type text NOT NULL,
  stable_id_hash text NOT NULL,
  source text NOT NULL CHECK (source IN ('api', 'browser', 'desktop')),
  url_fingerprint text,
  touch_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, owner_user_id, provider, object_type, stable_id_hash)
);

CREATE TABLE execution_routes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  run_id uuid NOT NULL REFERENCES agent_runs (id),
  step_id text NOT NULL,
  selected_source text NOT NULL,
  fallback_sources text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  estimated_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  confidence numeric(6,5) NOT NULL,
  verification text NOT NULL CHECK (verification IN ('independent_read', 'none')),
  on_failure text NOT NULL CHECK (on_failure IN ('try_next_fallback', 'stop_and_ask_user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id)
);

CREATE TABLE shadow_comparisons (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  agent_id uuid NOT NULL REFERENCES agents (id),
  run_id uuid NOT NULL REFERENCES agent_runs (id),
  agreement numeric(6,5) NOT NULL,
  matched integer NOT NULL,
  missed integer NOT NULL,
  extra integer NOT NULL,
  missing_rules jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id)
);

-- Append-only execution receipts (immutable evidence).
CREATE TABLE execution_receipts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  run_id uuid NOT NULL UNIQUE REFERENCES agent_runs (id),
  agent_id uuid NOT NULL REFERENCES agents (id),
  receipt jsonb NOT NULL,
  receipt_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER execution_receipts_immutable
  BEFORE UPDATE OR DELETE ON execution_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Permission-change audit (dedicated view over the audit chain domain).
CREATE TABLE permission_audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  actor_user_id uuid REFERENCES users (id),
  subject text NOT NULL,          -- e.g. 'connector:salesforce', 'browser_site:linkedin.com'
  change text NOT NULL CHECK (change IN ('granted', 'revoked', 'scope_upgraded', 'disabled', 'enabled')),
  detail jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER permission_audit_events_immutable
  BEFORE UPDATE OR DELETE ON permission_audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Connector scopes granted per account (normalized view of scope grants).
CREATE TABLE connector_scopes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  connector_account_id uuid NOT NULL REFERENCES connector_accounts (id),
  scope text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_user_id uuid REFERENCES users (id),
  UNIQUE (connector_account_id, scope)
);

-- RLS (FORCE) on every new tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'capability_availability', 'workflow_object_refs', 'execution_routes',
    'shadow_comparisons', 'execution_receipts', 'permission_audit_events',
    'connector_scopes'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_setting(''app.organization_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.organization_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

CREATE INDEX idx_capability_availability_lookup
  ON capability_availability (organization_id, owner_user_id, capability_id);
CREATE INDEX idx_object_refs_owner ON workflow_object_refs (organization_id, owner_user_id, provider);
CREATE INDEX idx_receipts_agent ON execution_receipts (organization_id, agent_id, created_at DESC);
CREATE INDEX idx_permission_audit_org ON permission_audit_events (organization_id, occurred_at DESC);
