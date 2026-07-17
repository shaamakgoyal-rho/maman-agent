export default function PrivacyPage() {
  return (
    <>
      <h1>What this console can and cannot see</h1>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Visible to administrators</h3>
        <ul className="muted">
          <li>Aggregate adoption, run counts, failure rates, cost, and net value</li>
          <li>Aggregates only when a cohort has at least five active users</li>
          <li>Policy configuration, connector health, and audit metadata</li>
        </ul>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Never visible — these endpoints do not exist</h3>
        <ul className="muted">
          <li>Any employee&apos;s raw workflow events or event history</li>
          <li>Screen content or screen replay</li>
          <li>Individual productivity scores or leaderboards</li>
          <li>Per-user time-on-device or active-window time</li>
          <li>Connector tokens (envelope-encrypted server-side, never returned)</li>
        </ul>
      </div>
    </>
  );
}
