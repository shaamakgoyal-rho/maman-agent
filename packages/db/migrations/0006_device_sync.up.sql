-- 0006: server-side sync ingest for redacted device projections.
-- Only identity-safe projections land here (enforced by the API contract).
-- Dedupe is on (organization_id, event_id): at-least-once upload, exactly-once store.

CREATE TABLE synced_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL,
  app_category text NOT NULL,
  event_type text NOT NULL,
  sensitivity text NOT NULL,
  excluded_from_learning boolean NOT NULL,
  projection jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, event_id)
);

ALTER TABLE synced_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE synced_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON synced_events
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

CREATE INDEX idx_synced_events_org_occurred ON synced_events (organization_id, occurred_at DESC);
CREATE INDEX idx_synced_events_owner ON synced_events (organization_id, owner_user_id, occurred_at DESC);
