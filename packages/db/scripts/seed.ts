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

  console.log(`seeded demo org "${DEMO_ORG.name}" (${orgId}) with ${DEMO_USERS.length} users`);
} finally {
  await close();
}
