import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";

export default function PoliciesPage() {
  const p = DEFAULT_ORG_POLICY;
  return (
    <>
      <h1>Policies</h1>
      <p className="muted">
        Current organization policy (read-only in this build). Changes create immutable policy
        versions and an audit event, and are re-evaluated before every run.
      </p>
      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Enabled connectors</h3>
          <p className="muted">{p.enabled_connectors.join(", ")}</p>
        </div>
        <div className="card">
          <h3>Write limits</h3>
          <p className="muted">
            {p.max_records_written} records/run · ${p.max_run_cost_usd}/run · $
            {p.max_monthly_model_cost_usd}/month model
          </p>
        </div>
        <div className="card">
          <h3>Approvals</h3>
          <p className="muted">
            High-risk steps always require run-specific approval and can never become unattended.
          </p>
        </div>
        <div className="card">
          <h3>Aggregate cohort minimum</h3>
          <p className="muted">{p.min_cohort_size} users (cannot be set lower)</p>
        </div>
        <div className="card">
          <h3>Scheduled supervised agents</h3>
          <p className="muted">{p.allow_scheduled_supervised ? "Allowed" : "Not allowed"}</p>
        </div>
        <div className="card">
          <h3>Model routing</h3>
          <p className="muted">
            {p.allow_remote_model ? "Redacted summaries may use a remote model" : "Local only"}
          </p>
        </div>
      </div>
    </>
  );
}
