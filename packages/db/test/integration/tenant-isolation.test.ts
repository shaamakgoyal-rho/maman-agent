import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@maman/contracts";
import {
  addMembership,
  createAgentWithVersion,
  createPattern,
  createPolicyVersion,
  createRecommendation,
  getAgentOwned,
  getDevice,
  getMembership,
  getPatternOwned,
  getRecommendationOwned,
  globalCreateOrganization,
  globalCreateUser,
  listRecommendationsOwned,
  orgFactory,
  patternFactory,
  recommendationFactory,
  registerDevice,
  userFactory,
} from "../../src/index.js";
import { withTenant, MissingTenantContextError } from "../../src/tenant.js";
import { startTestDb, type TestDb } from "./setup.js";

let db: TestDb;

// Two fully populated organizations to probe isolation in both directions.
let orgA: { id: string };
let orgB: { id: string };
let userA: { id: string };
let userB: { id: string };
let patternA: { id: string };
let recommendationA: { id: string };
let agentA: { id: string };
let deviceA: { id: string };

beforeAll(async () => {
  db = await startTestDb();
  const { sql } = db.client;

  orgA = await globalCreateOrganization(sql, orgFactory());
  orgB = await globalCreateOrganization(sql, orgFactory());
  userA = await globalCreateUser(sql, userFactory());
  userB = await globalCreateUser(sql, userFactory());

  const ctxA = { organizationId: orgA.id, userId: userA.id };
  const ctxB = { organizationId: orgB.id, userId: userB.id };

  await addMembership(sql, ctxA, { user_id: userA.id, role: "member" });
  await addMembership(sql, ctxB, { user_id: userB.id, role: "member" });

  patternA = await createPattern(
    sql,
    ctxA,
    patternFactory({ organization_id: orgA.id, owner_user_id: userA.id }),
  );
  recommendationA = await createRecommendation(
    sql,
    ctxA,
    recommendationFactory({
      organization_id: orgA.id,
      owner_user_id: userA.id,
      pattern_id: patternA.id,
    }),
  );
  deviceA = await registerDevice(sql, ctxA, {
    id: uuidv7(),
    organization_id: orgA.id,
    owner_user_id: userA.id,
    device_public_id: uuidv7(),
    platform: "macos",
    app_version: "0.1.0",
    observer_version: "0.1.0",
    capabilities: ["demo_observer"],
  });
  const policy = await createPolicyVersion(sql, ctxA, {
    id: uuidv7(),
    organization_id: orgA.id,
    version_number: 1,
    policy: { rules: [] },
    sha256: "test",
    created_by_user_id: userA.id,
  });
  const agentId = uuidv7();
  const created = await createAgentWithVersion(
    sql,
    ctxA,
    {
      id: agentId,
      organization_id: orgA.id,
      owner_user_id: userA.id,
      name: "Test agent",
      description: "d",
      state: "draft",
    },
    {
      id: uuidv7(),
      organization_id: orgA.id,
      agent_id: agentId,
      version_number: 1,
      schema_version: 1,
      spec: {},
      spec_sha256: "abc",
      created_by_type: "compiler",
      policy_version_id: policy.id,
    },
  );
  agentA = created.agent;
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe("tenant context requirement", () => {
  it("refuses to run without an organization id", async () => {
    await expect(withTenant(db.client.sql, { organizationId: "" }, async () => 1)).rejects.toThrow(
      MissingTenantContextError,
    );
  });
});

describe("cross-tenant denial via repositories (returns null, never foreign rows)", () => {
  const foreignCtx = () => ({ organizationId: orgB.id, userId: userB.id });

  it("patterns: org B cannot read org A's pattern by ID", async () => {
    expect(await getPatternOwned(db.client.sql, foreignCtx(), patternA.id)).toBeNull();
  });

  it("recommendations: org B cannot read org A's recommendation by ID", async () => {
    expect(
      await getRecommendationOwned(db.client.sql, foreignCtx(), recommendationA.id),
    ).toBeNull();
  });

  it("recommendations: org B list never contains org A rows", async () => {
    const rows = await listRecommendationsOwned(db.client.sql, foreignCtx());
    expect(rows.map((r) => r.id)).not.toContain(recommendationA.id);
  });

  it("agents: org B cannot read org A's agent by ID", async () => {
    expect(await getAgentOwned(db.client.sql, foreignCtx(), agentA.id)).toBeNull();
  });

  it("devices: org B cannot read org A's device by ID", async () => {
    expect(await getDevice(db.client.sql, foreignCtx(), deviceA.id)).toBeNull();
  });

  it("memberships: org B cannot see org A's membership", async () => {
    expect(await getMembership(db.client.sql, foreignCtx(), userA.id)).toBeNull();
  });
});

describe("cross-tenant denial at the database (RLS), even with raw SQL", () => {
  // Simulates an application bug that forgets the WHERE organization_id filter:
  // RLS must still hide foreign rows in every tenant table family.
  const rawProbe = (table: string) =>
    withTenant(db.client.sql, { organizationId: orgB.id }, async (tx) => {
      const rows = await tx.unsafe(`SELECT organization_id FROM ${table}`);
      return rows as unknown as Array<{ organization_id: string }>;
    });

  for (const table of [
    "memberships",
    "devices",
    "device_sessions",
    "patterns",
    "recommendations",
    "agents",
    "agent_versions",
    "agent_runs",
    "run_steps",
    "approvals",
    "policy_versions",
    "usage_reservations",
    "connector_accounts",
    "roi_baselines",
    "roi_measurements",
    "audit_events",
    "audit_chain_heads",
    "capability_availability",
    "workflow_object_refs",
    "execution_routes",
    "shadow_comparisons",
    "execution_receipts",
    "permission_audit_events",
    "connector_scopes",
  ]) {
    it(`${table}: unfiltered SELECT under org B returns zero org A rows`, async () => {
      const rows = await rawProbe(table);
      expect(rows.every((r) => r.organization_id === orgB.id)).toBe(true);
      expect(rows.some((r) => r.organization_id === orgA.id)).toBe(false);
    });
  }

  it("RLS blocks cross-tenant INSERT (WITH CHECK)", async () => {
    await expect(
      withTenant(db.client.sql, { organizationId: orgB.id }, async (tx) => {
        await tx`
          INSERT INTO patterns (
            id, organization_id, owner_user_id, local_pattern_id, generalized_intent,
            app_categories, occurrence_count, distinct_day_count, median_duration_ms,
            similarity_mean, projected_minutes_saved_weekly, opportunity_score, risk_score,
            share_status, status, summary_payload
          ) VALUES (
            ${uuidv7()}, ${orgA.id}, ${userA.id}, ${uuidv7()}, 'sneaky',
            ARRAY['crm'], 1, 1, 1000, 0.9, 10, 0.7, 0.1, 'private', 'candidate', '{}'
          )
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("RLS blocks cross-tenant UPDATE (rows invisible, zero affected)", async () => {
    const updated = await withTenant(db.client.sql, { organizationId: orgB.id }, async (tx) => {
      const rows = await tx`
        UPDATE patterns SET generalized_intent = 'hijacked'
        WHERE id = ${patternA.id}
        RETURNING id
      `;
      return rows.length;
    });
    expect(updated).toBe(0);
    // Confirm org A's row is untouched.
    const intact = await getPatternOwned(
      db.client.sql,
      { organizationId: orgA.id, userId: userA.id },
      patternA.id,
    );
    expect(intact?.generalized_intent).toBe("reconcile_account_list");
  });

  it("RLS blocks cross-tenant DELETE", async () => {
    const deleted = await withTenant(db.client.sql, { organizationId: orgB.id }, async (tx) => {
      const rows =
        await tx`DELETE FROM recommendations WHERE id = ${recommendationA.id} RETURNING id`;
      return rows.length;
    });
    expect(deleted).toBe(0);
  });
});

describe("append-only guarantees", () => {
  it("agent_versions rejects UPDATE even inside a valid tenant transaction", async () => {
    await expect(
      withTenant(db.client.sql, { organizationId: orgA.id }, async (tx) => {
        await tx`UPDATE agent_versions SET spec_sha256 = 'tampered' WHERE organization_id = ${orgA.id}`;
      }),
    ).rejects.toThrow(/append-only/);
  });
});
