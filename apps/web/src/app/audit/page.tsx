import { admin } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const entries = await admin.audit();

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Policy and execution metadata only — never personal raw events or workflow content. Export
        produces a signed, expiring, metadata-only download.
      </p>
      {!entries || entries.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted">No audit events yet.</p>
        </div>
      ) : (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td>{new Date(e.occurred_at).toLocaleString()}</td>
                <td>{e.actor_type}</td>
                <td>{e.action}</td>
                <td>{e.resource_type}</td>
                <td>
                  <span
                    className={`pill ${e.outcome === "success" ? "ok" : e.outcome === "denied" ? "warn" : "bad"}`}
                  >
                    {e.outcome}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
