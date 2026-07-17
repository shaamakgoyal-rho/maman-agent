/**
 * Resets demo data only: removes rows belonging to the demo organization,
 * then re-runs the seed. Requires explicit confirmation.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createDbClient } from "../src/client.js";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, "..", "..", "..", ".env") });

if (process.env["CONFIRM_DEMO_RESET"] !== "maman-agent") {
  console.error("Set CONFIRM_DEMO_RESET=maman-agent to confirm demo data reset.");
  process.exit(1);
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const { sql, close } = createDbClient(databaseUrl, { max: 1 });

try {
  const [org] = await sql<{ id: string }[]>`
    SELECT id FROM organizations WHERE workos_organization_id = 'org_demo_acme_sales'
  `;
  if (!org) {
    console.log("demo organization not present — nothing to reset");
  } else {
    // Order respects FKs. Demo scope only: everything filtered by the demo org id.
    const tables = [
      "roi_measurements",
      "roi_baselines",
      "usage_reservations",
      "approvals",
      "run_steps",
      "agent_runs",
      "agent_versions",
      "agents",
      "recommendations",
      "patterns",
      "connector_accounts",
      "policy_versions",
      "audit_events",
      "audit_chain_heads",
      "device_sessions",
      "devices",
      "memberships",
    ];
    await sql.begin(async (tx) => {
      // agent_versions/audit_events are append-only; demo reset is the explicit exception.
      await tx`ALTER TABLE agent_versions DISABLE TRIGGER agent_versions_immutable`;
      await tx`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable`;
      for (const table of tables) {
        await tx.unsafe(`DELETE FROM ${table} WHERE organization_id = '${org.id}'`);
      }
      await tx`ALTER TABLE agent_versions ENABLE TRIGGER agent_versions_immutable`;
      await tx`ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable`;
    });
    console.log("demo organization data cleared");
  }
} finally {
  await close();
}

// Re-seed
await import("./seed.js");
