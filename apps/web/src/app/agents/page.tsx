import { admin } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const overview = await admin.overview();
  const agents = overview && !overview.unavailable ? overview.agents : {};
  return (
    <>
      <h1>Agents</h1>
      <p className="muted">
        Counts by lifecycle state across the organization. No agent contents or per-user detail.
      </p>
      <div className="grid" style={{ marginTop: 16 }}>
        {Object.entries(agents).length === 0 ? (
          <div className="card">
            <p className="muted">No agents yet.</p>
          </div>
        ) : (
          Object.entries(agents).map(([state, n]) => (
            <div className="card" key={state}>
              <h3>{state}</h3>
              <div className="big">{n as number}</div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
