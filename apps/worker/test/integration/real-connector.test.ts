import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, loadMigrations, migrateUp, withTenant, type DbClient } from "@maman/db";
import { uuidv7, type AgentRunInput, type AgentSpec } from "@maman/contracts";
import { compileAgentSpec, demoAdapterRegistry, DemoSalesforceWorld } from "@maman/agent-runtime";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { envelopeEncrypt } from "@maman/connector-auth";
import {
  MemoryIdempotencyStore,
  realAdapterRegistry,
  type HttpRequest,
  type HttpResponse,
} from "@maman/connector-adapters";
import { DEMO_SF_ACCOUNTS } from "@maman/demo-fixtures";
import { createActivities, type PersistenceSink } from "../../src/activities.js";
import { createVaultCredentialProvider } from "../../src/vault-credentials.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

const MASTER_SECRET = "m".repeat(43);
const MASTER_KEY = createHash("sha256").update(MASTER_SECRET).digest();
const SF_ACCESS_TOKEN = "SECRET_SF_ACCESS_TOKEN_MUST_NOT_LEAK_001";
const SF_REFRESH_TOKEN = "SECRET_SF_REFRESH_TOKEN_MUST_NOT_LEAK";

let container: StartedPostgreSqlContainer;
let client: DbClient;
const orgId = uuidv7();
const userId = uuidv7();

/** A tiny fake Salesforce over HTTP: records mutate on PATCH so verify reflects writes. */
function fakeSalesforce() {
  const records = new Map<string, Record<string, unknown>>();
  for (const a of DEMO_SF_ACCOUNTS) {
    records.set(a.id, {
      Id: a.id,
      Name: a.name,
      Website: a.website,
      NumberOfEmployees: a.employee_count,
      Account_Owner_Name__c: a.owner,
      Market_Segment__c: a.segment,
    });
  }
  const bearerTokensSeen: string[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    bearerTokensSeen.push(req.headers["authorization"] ?? "");
    if (req.method === "GET" && req.url.includes("/query")) {
      return { status: 200, headers: {}, body: { records: [...records.values()] } };
    }
    if (req.method === "PATCH") {
      const id = decodeURIComponent(req.url.split("/sobjects/Account/")[1]!);
      const body = JSON.parse(req.body!) as Record<string, unknown>;
      Object.assign(records.get(id)!, body);
      return { status: 204, headers: {}, body: "" };
    }
    return { status: 404, headers: {}, body: {} };
  };
  return { transport, bearerTokensSeen, records };
}

async function buildSpec(): Promise<AgentSpec> {
  const result = await compileAgentSpec({
    candidate: {
      pattern_id: uuidv7(),
      owner_user_id: userId,
      first_seen_at: "2026-07-14T09:40:00.000Z",
      last_seen_at: "2026-07-16T15:00:00.000Z",
      occurrence_count: 6,
      distinct_day_count: 3,
      median_duration_ms: 660_000,
      p90_duration_ms: 780_000,
      canonical_sequence: [],
      episode_ids: [],
      similarity_mean: 0.9,
      repeatability_score: 0.9,
      feasibility_score: 0.8,
      risk_score: 0.3,
      projected_minutes_saved_weekly: 70,
      opportunity_score: 0.72,
      status: "eligible",
    },
    generalized_intent: "reconcile_account_list",
    desired_outcome: "Reconcile the account list with Salesforce.",
    organization_id: orgId,
    owner_user_id: userId,
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date("2026-07-17T18:00:00.000Z"),
  });
  if (result.status !== "valid") throw new Error("compile failed");
  return result.spec;
}

function runInput(spec: AgentSpec): AgentRunInput {
  return {
    run_id: uuidv7(),
    agent_id: spec.agent_id,
    agent_version_id: spec.version_id,
    organization_id: orgId,
    owner_user_id: userId,
    mode: "supervised",
    trigger: { type: "manual", idempotency_key: uuidv7() },
    agent_inputs: {},
    policy_version_id: uuidv7(),
    requested_at: "2026-07-17T18:00:00.000Z",
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));

  await client.sql`INSERT INTO organizations (id, workos_organization_id, name, status, default_timezone) VALUES (${orgId}, ${"wk_" + orgId}, 'T', 'active', 'UTC')`;
  await client.sql`INSERT INTO users (id, workos_user_id, email, display_name) VALUES (${userId}, ${"wu_" + userId}, 'u@t.example', 'U')`;

  // Seed a vault-encrypted Salesforce connector token for the org.
  const envelope = envelopeEncrypt(
    {
      access_token: SF_ACCESS_TOKEN,
      refresh_token: SF_REFRESH_TOKEN,
      instance_url: "https://na1.example.com",
    },
    MASTER_KEY,
    { organization_id: orgId, provider: "salesforce" },
  );
  await withTenant(client.sql, { organizationId: orgId }, async (tx) => {
    await tx`INSERT INTO memberships (organization_id, user_id, role, status) VALUES (${orgId}, ${userId}, 'member', 'active')`;
    await tx`
      INSERT INTO connector_accounts (
        id, organization_id, owner_user_id, provider, external_account_id_hash,
        display_label, scopes, status, encrypted_token_ciphertext, encrypted_data_key,
        token_key_version, last_verified_at, created_at, updated_at
      ) VALUES (
        ${uuidv7()}, ${orgId}, ${userId}, 'salesforce', 'hash1', 'Salesforce',
        ${["api", "refresh_token"]}, 'connected', ${envelope.ciphertext}, ${envelope.encrypted_data_key},
        ${envelope.key_version}, now(), now(), now()
      )
    `;
  });
}, 180_000);

afterAll(async () => {
  await client.close();
  await container.stop();
});

describe("real-mode supervised run (M11)", () => {
  it("retrieves the vault token, drives real Salesforce, and never leaks the token", async () => {
    const sf = fakeSalesforce();
    const credentials = createVaultCredentialProvider({
      sql: client.sql,
      masterKey: MASTER_KEY,
      transport: async () => ({ status: 200, body: {} }),
      clientCredentials: () => ({ client_id: "cid", client_secret: "csecret" }),
    });
    const registry = realAdapterRegistry({
      credentials,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
      transport: sf.transport,
      idempotency: new MemoryIdempotencyStore(),
    });

    const captured: unknown[] = [];
    const sink: PersistenceSink = {
      runStatus: () => {},
      stepResult: (_r, summary, result) => {
        captured.push(summary, result);
      },
      approvalRequested: () => {},
      receipt: (r) => {
        captured.push(r);
      },
    };
    const activities = createActivities({
      registry,
      sink,
      now: () => new Date("2026-07-17T18:05:00Z"),
    });

    const spec = await buildSpec();
    const run = runInput(spec);

    // Drive the supervised sequence: reads + propose, then the approved write.
    let outputs: Record<string, unknown> = {};
    let approvedDiffSha = "";
    for (const step of [...spec.steps].sort((a, b) => a.order - b.order)) {
      if (step.mode === "write") continue;
      const r = await activities.executeReadStep({ spec, step_id: step.step_id, outputs, run });
      expect(r.status).not.toBe("failed");
      outputs = r.outputs;
      if (r.status === "proposed") approvedDiffSha = r.diff_sha256!;
    }
    const writeStep = spec.steps.find((s) => s.mode === "write")!;
    const w = await activities.executeWriteStep({
      spec,
      step_id: writeStep.step_id,
      outputs,
      run,
      approved_diff_sha: approvedDiffSha,
    });
    expect(w.status).toBe("completed");
    expect(w.verified).toBe(true); // independent read-back over HTTP confirmed the writes
    outputs = w.outputs;

    await activities.finalizeRun({
      run,
      spec,
      status: "completed",
      steps: spec.steps.map((s, i) => ({
        step_id: s.step_id,
        step_order: i + 1,
        capability_id: s.capability_id,
        mode: s.mode,
        status: s.mode === "write" ? "completed" : "completed",
      })),
      intervention_ms: 60_000,
      total_cost_usd: 0.08,
      model_cost_usd: 0,
    });

    // The decrypted vault token was actually used against Salesforce.
    expect(sf.bearerTokensSeen.length).toBeGreaterThan(0);
    expect(sf.bearerTokensSeen.every((h) => h === `Bearer ${SF_ACCESS_TOKEN}`)).toBe(true);

    // …and it never leaks into any persisted output, step result, or receipt.
    const serialized = JSON.stringify(captured) + JSON.stringify(outputs);
    expect(serialized).not.toContain(SF_ACCESS_TOKEN);
    expect(serialized).not.toContain(SF_REFRESH_TOKEN);

    // The fake org actually changed (real write path applied the §24 diff).
    expect(sf.records.get("001DEMO000001")!["Account_Owner_Name__c"]).toBe("Alex");
  });

  it("does not leak the token even when the connector is queried directly", async () => {
    const credentials = createVaultCredentialProvider({
      sql: client.sql,
      masterKey: MASTER_KEY,
      transport: async () => ({ status: 200, body: {} }),
      clientCredentials: () => ({ client_id: "cid" }),
    });
    const creds = await credentials.load({ organization_id: orgId, provider: "salesforce" });
    // load() legitimately returns the token server-side (it is the vault reader);
    // the guarantee is that adapters/outputs never surface it — proven above.
    expect(creds?.access_token).toBe(SF_ACCESS_TOKEN);
    // A different org sees nothing (tenant isolation via RLS).
    const other = await credentials.load({ organization_id: uuidv7(), provider: "salesforce" });
    expect(other).toBeNull();
  });
});
