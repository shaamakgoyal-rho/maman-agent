/**
 * Seeds the demo organization and six demo identities (spec §24).
 * Idempotent: running twice does not duplicate rows.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { uuidv7 } from "@maman/contracts";
import { createDbClient } from "../src/client.js";
import { withTenant } from "../src/tenant.js";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, "..", "..", "..", ".env") });

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

export const DEMO_ORG = {
  workos_organization_id: "org_demo_acme_sales",
  name: "Acme Sales Demo",
  default_timezone: "America/Los_Angeles",
  loaded_hourly_rate_usd: "75.000000",
};

export const DEMO_USERS = [
  { key: "alex", display_name: "Alex", email: "alex@acme-sales.example", role: "member" }, // AE
  { key: "sam", display_name: "Sam", email: "sam@acme-sales.example", role: "member" }, // SDR
  { key: "riley", display_name: "Riley", email: "riley@acme-sales.example", role: "member" }, // BDR
  { key: "morgan", display_name: "Morgan", email: "morgan@acme-sales.example", role: "member" }, // RevOps
  { key: "jordan", display_name: "Jordan", email: "jordan@acme-sales.example", role: "manager" }, // Sales Manager
  { key: "taylor", display_name: "Taylor", email: "taylor@acme-sales.example", role: "org_admin" }, // Org Admin
] as const;

const { sql, close } = createDbClient(databaseUrl, { max: 1 });

try {
  // Organization (idempotent upsert)
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (id, workos_organization_id, name, status, default_timezone, loaded_hourly_rate_usd)
    VALUES (${uuidv7()}, ${DEMO_ORG.workos_organization_id}, ${DEMO_ORG.name}, 'active',
            ${DEMO_ORG.default_timezone}, ${DEMO_ORG.loaded_hourly_rate_usd})
    ON CONFLICT (workos_organization_id)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const orgId = org!.id;

  for (const u of DEMO_USERS) {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (id, workos_user_id, email, display_name)
      VALUES (${uuidv7()}, ${"user_demo_" + u.key}, ${u.email}, ${u.display_name})
      ON CONFLICT (workos_user_id)
      DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `;
    await withTenant(sql, { organizationId: orgId }, async (tx) => {
      await tx`
        INSERT INTO memberships (organization_id, user_id, role, status)
        VALUES (${orgId}, ${user!.id}, ${u.role}, 'active')
        ON CONFLICT (organization_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, status = 'active'
      `;
    });
  }

  // Seed a demo agent + verified ROI measurements for all six users so the
  // admin overview has an aggregate above the five-person cohort minimum.
  await withTenant(sql, { organizationId: orgId }, async (tx) => {
    // Idempotent: the derived agent/run/ROI rows use fresh UUIDs each run, so
    // only seed them when the org has none yet. A re-run (or `pnpm demo` on an
    // already-seeded database) is a no-op here. `db:reset-demo` clears first.
    const [existing] = await tx<{ n: string }[]>`
      SELECT COUNT(*) AS n FROM agent_runs WHERE organization_id = ${orgId}
    `;
    if (Number(existing?.n ?? 0) > 0) {
      console.log("demo ROI already seeded — skipping");
      return;
    }
    const members = await tx<{ user_id: string }[]>`
      SELECT user_id FROM memberships WHERE organization_id = ${orgId}
    `;
    for (const [i, member] of members.entries()) {
      const agentId = uuidv7();
      const versionId = uuidv7();
      const policyId = uuidv7();
      await tx`
        INSERT INTO policy_versions (id, organization_id, version_number, policy, sha256, created_by_user_id)
        VALUES (${policyId}, ${orgId}, ${1000 + i}, '{"rules":[]}', ${"seed" + i}, ${member.user_id})
        ON CONFLICT DO NOTHING
      `;
      await tx`
        INSERT INTO agents (id, organization_id, owner_user_id, name, description, state, current_version_id)
        VALUES (${agentId}, ${orgId}, ${member.user_id}, 'Reconcile account lists with Salesforce', 'demo', 'supervised', ${versionId})
        ON CONFLICT DO NOTHING
      `;
      await tx`
        INSERT INTO agent_versions (id, organization_id, agent_id, version_number, schema_version, spec, spec_sha256, created_by_type, policy_version_id)
        VALUES (${versionId}, ${orgId}, ${agentId}, 1, 1, '{}', ${"spec" + i}, 'compiler', ${policyId})
        ON CONFLICT DO NOTHING
      `;
      const runId = uuidv7();
      await tx`
        INSERT INTO agent_runs (id, organization_id, owner_user_id, agent_id, agent_version_id, temporal_workflow_id, trigger_type, trigger_idempotency_key, mode, status, policy_version_id, requested_at, model_cost_usd, connector_cost_usd)
        VALUES (${runId}, ${orgId}, ${member.user_id}, ${agentId}, ${versionId}, ${"wf-seed-" + i}, 'manual', ${"idem-seed-" + i}, 'supervised', 'completed', ${policyId}, now(), 0.01, 0.07)
        ON CONFLICT DO NOTHING
      `;
      // ~17 verified minutes saved per run, net value at $75/h loaded rate.
      const savedMs = 17 * 60_000;
      const netUsd = ((savedMs / 3_600_000) * 75 - 0.08).toFixed(6);
      await tx`
        INSERT INTO roi_measurements (id, organization_id, owner_user_id, agent_id, run_id, baseline_ms, automated_human_ms, intervention_ms, verified_saved_ms, gross_value_usd, model_cost_usd, connector_cost_usd, infrastructure_cost_usd, net_value_usd, verification_status)
        VALUES (${uuidv7()}, ${orgId}, ${member.user_id}, ${agentId}, ${runId}, ${20 * 60_000}, ${60_000}, ${60_000}, ${savedMs}, ${((savedMs / 3_600_000) * 75).toFixed(6)}, 0.01, 0.07, 0, ${netUsd}, 'verified')
        ON CONFLICT DO NOTHING
      `;
    }
  });

  console.log(
    `seeded demo org "${DEMO_ORG.name}" (${orgId}) with ${DEMO_USERS.length} users + ROI`,
  );
} finally {
  await close();
}
