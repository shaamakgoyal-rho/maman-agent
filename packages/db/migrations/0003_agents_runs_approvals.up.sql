-- 0003: agents, immutable versions, runs, steps, approvals

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  source_pattern_id uuid REFERENCES patterns (id),
  source_recommendation_id uuid REFERENCES recommendations (id),
  name text NOT NULL,
  description text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'shadow', 'supervised', 'active', 'paused', 'degraded', 'revoked', 'archived')),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Append-only: immutable agent versions. UPDATE/DELETE revoked below.
CREATE TABLE agent_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  agent_id uuid NOT NULL REFERENCES agents (id),
  version_number integer NOT NULL,
  schema_version integer NOT NULL,
  spec jsonb NOT NULL,
  spec_sha256 text NOT NULL,
  created_by_user_id uuid REFERENCES users (id),
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'compiler', 'migration')),
  policy_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version_number),
  UNIQUE (agent_id, spec_sha256)
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  agent_id uuid NOT NULL REFERENCES agents (id),
  agent_version_id uuid NOT NULL REFERENCES agent_versions (id),
  temporal_workflow_id text UNIQUE NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'schedule', 'event')),
  trigger_idempotency_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow', 'supervised', 'active')),
  status text NOT NULL CHECK (status IN (
    'queued', 'validating', 'running_read', 'preparing_diff', 'waiting_approval',
    'applying_write', 'verifying', 'completed', 'completed_with_warnings', 'failed',
    'cancelled', 'expired', 'budget_exceeded', 'policy_blocked'
  )),
  policy_version_id uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  model_input_tokens bigint NOT NULL DEFAULT 0,
  model_output_tokens bigint NOT NULL DEFAULT 0,
  model_cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  connector_cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  intervention_ms bigint NOT NULL DEFAULT 0,
  error_code text,
  error_summary text,
  UNIQUE (organization_id, trigger_idempotency_key)
);

CREATE TABLE run_steps (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  run_id uuid NOT NULL REFERENCES agent_runs (id),
  step_id text NOT NULL,
  step_order integer NOT NULL,
  capability_id text NOT NULL,
  capability_version integer NOT NULL,
  mode text NOT NULL CHECK (mode IN ('read', 'propose_write', 'write')),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'prohibited')),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'skipped')),
  input_digest text NOT NULL,
  output_payload jsonb,
  diff_payload jsonb,
  diff_sha256 text,
  idempotency_key text,
  attempt_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_summary text,
  UNIQUE (run_id, step_id)
);

CREATE UNIQUE INDEX uniq_run_steps_idempotency_key
  ON run_steps (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  run_id uuid NOT NULL REFERENCES agent_runs (id),
  run_step_id uuid NOT NULL REFERENCES run_steps (id),
  requested_from_user_id uuid NOT NULL REFERENCES users (id),
  diff_sha256 text NOT NULL,
  token_sha256 text UNIQUE NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by_user_id uuid REFERENCES users (id),
  reason text
);

-- Immutability guard for agent_versions (append-only).
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_versions_immutable
  BEFORE UPDATE OR DELETE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_versions
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_runs
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_steps
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approvals
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

CREATE INDEX idx_agents_org_owner_state ON agents (organization_id, owner_user_id, state);
CREATE INDEX idx_agent_runs_agent_requested ON agent_runs (organization_id, agent_id, requested_at DESC);
CREATE INDEX idx_run_steps_run ON run_steps (organization_id, run_id, step_order);
CREATE INDEX idx_approvals_pending_user
  ON approvals (organization_id, requested_from_user_id, expires_at)
  WHERE status = 'pending';
