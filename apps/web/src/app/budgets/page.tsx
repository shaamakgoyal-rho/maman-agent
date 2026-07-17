import { admin } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const overview = await admin.overview();
  const cost =
    overview && !overview.unavailable ? overview.cost : { model_usd: 0, connector_usd: 0 };
  return (
    <>
      <h1>Budgets & cost</h1>
      <p className="muted">
        Aggregate spend to date. Per-run and monthly ceilings are set in Policies.
      </p>
      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Model cost</h3>
          <div className="big">${cost.model_usd.toFixed(2)}</div>
        </div>
        <div className="card">
          <h3>Connector cost</h3>
          <div className="big">${cost.connector_usd.toFixed(2)}</div>
        </div>
      </div>
    </>
  );
}
