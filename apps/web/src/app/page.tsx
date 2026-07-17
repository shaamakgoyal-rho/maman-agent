import { admin } from "@/lib/api";

export const dynamic = "force-dynamic";

function Card({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="big">{value}</div>
      {note && <p className="muted">{note}</p>}
    </div>
  );
}

export default async function OverviewPage() {
  const overview = await admin.overview();

  if (!overview || overview.unavailable) {
    return (
      <div className="card">
        <h3>Overview</h3>
        <p className="muted">
          The API is not reachable, or the organization has no data yet. Run <code>pnpm demo</code>{" "}
          to start the stack and seed the demo organization.
        </p>
      </div>
    );
  }

  const agents = overview.agents;
  const agentTotal = Object.values(agents).reduce((a, b) => a + b, 0);

  return (
    <>
      <h1>Organization overview</h1>
      <p className="muted">
        Aggregate figures only. No screen content, no individual activity, no productivity ranking —
        those never leave the employee&apos;s device.
      </p>

      <div className="grid" style={{ marginTop: 16 }}>
        <Card
          title="Active seats"
          value={`${overview.seats.active_users}/${overview.seats.provisioned}`}
          note="active of provisioned"
        />
        <Card
          title="Devices healthy"
          value={String(overview.devices.healthy)}
          note={`${overview.devices.offline} offline`}
        />
        <Card
          title="Recommendations"
          value={String(overview.recommendations.created)}
          note={`${overview.recommendations.accepted} accepted · ${overview.recommendations.dismissed} dismissed`}
        />
        <Card
          title="Agents"
          value={String(agentTotal)}
          note={Object.entries(agents)
            .map(([s, n]) => `${n} ${s}`)
            .join(" · ")}
        />
        <Card
          title="Run success"
          value={`${overview.runs.completed}/${overview.runs.total}`}
          note={`${overview.runs.failed} failed`}
        />
        {overview.value.suppressed ? (
          <Card title="Verified hours" value="—" note={overview.value.reason} />
        ) : (
          <>
            <Card
              title="Verified hours returned"
              value={overview.value.verified_hours.toFixed(1)}
              note={`across ${overview.value.cohort_size} active users`}
            />
            <Card
              title="Net value"
              value={`$${overview.value.net_value_usd.toFixed(2)}`}
              note="verified value minus cost"
            />
          </>
        )}
        <Card
          title="Cost"
          value={`$${(overview.cost.model_usd + overview.cost.connector_usd).toFixed(2)}`}
          note={`model $${overview.cost.model_usd.toFixed(2)} · connector $${overview.cost.connector_usd.toFixed(2)}`}
        />
        <Card
          title="Policy blocks"
          value={String(overview.policy_blocks)}
          note="unapproved actions prevented"
        />
        <Card
          title="Connectors"
          value={String(overview.connectors_needing_attention)}
          note="needing attention"
        />
      </div>
    </>
  );
}
