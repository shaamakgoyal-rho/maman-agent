-- 0002: patterns and recommendations

CREATE TABLE patterns (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  local_pattern_id uuid NOT NULL,
  generalized_intent text NOT NULL,
  app_categories text[] NOT NULL,
  occurrence_count integer NOT NULL,
  distinct_day_count integer NOT NULL,
  median_duration_ms integer NOT NULL,
  similarity_mean numeric(6, 5) NOT NULL,
  projected_minutes_saved_weekly numeric(10, 2) NOT NULL,
  opportunity_score numeric(6, 5) NOT NULL,
  risk_score numeric(6, 5) NOT NULL,
  share_status text NOT NULL CHECK (share_status IN ('private', 'org_pattern')),
  status text NOT NULL CHECK (status IN ('candidate', 'eligible', 'suggested', 'dismissed', 'converted')),
  summary_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, owner_user_id, local_pattern_id)
);

CREATE TABLE recommendations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  pattern_id uuid NOT NULL REFERENCES patterns (id),
  title text NOT NULL,
  summary text NOT NULL,
  evidence_payload jsonb NOT NULL,
  confidence numeric(6, 5) NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  projected_minutes_saved_weekly numeric(10, 2) NOT NULL,
  expected_cost_low numeric(14, 6) NOT NULL,
  expected_cost_high numeric(14, 6) NOT NULL,
  required_capabilities text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('new', 'viewed', 'snoozed', 'dismissed', 'blocked', 'accepted')),
  dismissal_reason text CHECK (
    dismissal_reason IS NULL
    OR dismissal_reason IN ('irrelevant', 'already_automated', 'too_risky', 'not_enough_value', 'wrong_pattern', 'never_suggest')
  ),
  surfaced_at timestamptz,
  snoozed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only one active (non-terminal) recommendation per pattern.
CREATE UNIQUE INDEX uniq_active_recommendation_per_pattern
  ON recommendations (pattern_id)
  WHERE status IN ('new', 'viewed', 'snoozed');

ALTER TABLE patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE patterns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patterns
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recommendations
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

CREATE INDEX idx_patterns_org_owner_status ON patterns (organization_id, owner_user_id, status);
CREATE INDEX idx_recommendations_owner_status_created
  ON recommendations (organization_id, owner_user_id, status, created_at DESC);
