import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createDbClient, loadMigrations, migrateUp, withTenant, type DbClient } from "@maman/db";
import { uuidv7 } from "@maman/contracts";
import type { ServerEnv } from "@maman/config";
import type { TokenTransport } from "@maman/connector-auth";
import { buildServer } from "../../src/server.js";

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

let container: StartedPostgreSqlContainer;
let client: DbClient;
let app: FastifyInstance;
let orgId: string;
const userId = uuidv7();

const SECRET_TOKEN = "SECRET_SALESFORCE_ACCESS_TOKEN_DO_NOT_LEAK";
const mockTransport: TokenTransport = async () => ({
  status: 200,
  body: { access_token: SECRET_TOKEN, refresh_token: "SECRET_REFRESH", expires_in: 3600 },
});

const env: ServerEnv = {
  NODE_ENV: "test",
  AUTH_MODE: "dev",
  MODEL_PROVIDER: "demo",
  CONNECTOR_MODE: "demo",
  DATABASE_URL: "postgres://localhost:5432/x",
  REDIS_URL: "redis://localhost:6379",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
  DEVICE_TOKEN_SIGNING_SECRET: "d".repeat(43),
  OAUTH_STATE_SIGNING_SECRET: "o".repeat(43),
  CONNECTOR_ENCRYPTION_MASTER_KEY: "c".repeat(43),
};

const headers = () => ({
  "x-dev-org-id": orgId,
  "x-dev-user-id": userId,
  "x-dev-role": "member",
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));

  orgId = uuidv7();
  await client.sql`INSERT INTO organizations (id, workos_organization_id, name, status, default_timezone) VALUES (${orgId}, ${"wk_" + orgId}, 'T', 'active', 'UTC')`;
  await client.sql`INSERT INTO users (id, workos_user_id, email, display_name) VALUES (${userId}, ${"wu_" + userId}, 'u@t.example', 'U')`;
  await withTenant(client.sql, { organizationId: orgId }, async (tx) => {
    await tx`INSERT INTO memberships (organization_id, user_id, role, status) VALUES (${orgId}, ${userId}, 'member', 'active')`;
    // A supervised agent whose spec references salesforce → paused on disconnect.
    const agentId = uuidv7();
    const versionId = uuidv7();
    const policyId = uuidv7();
    await tx`INSERT INTO policy_versions (id, organization_id, version_number, policy, sha256, created_by_user_id) VALUES (${policyId}, ${orgId}, 1, '{}', 's', ${userId})`;
    await tx`INSERT INTO agents (id, organization_id, owner_user_id, name, description, state) VALUES (${agentId}, ${orgId}, ${userId}, 'A', 'd', 'supervised')`;
    await tx`INSERT INTO agent_versions (id, organization_id, agent_id, version_number, schema_version, spec, spec_sha256, created_by_type, policy_version_id) VALUES (${versionId}, ${orgId}, ${agentId}, 1, 1, ${'{"steps":[{"capability_id":"salesforce.update_fields"}]}'}::jsonb, 'sp', 'compiler', ${policyId})`;
  });

  app = buildServer({ env, sql: client.sql, connectorTransport: mockTransport });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await client.close();
  await container.stop();
});

describe("connector broker (M8)", () => {
  it("lists providers including Slack and HubSpot, none exposing send/delete", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/connectors", headers: headers() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.providers.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["salesforce", "slack", "hubspot", "gmail"]));
    const gmail = body.providers.find((p: { id: string }) => p.id === "gmail");
    expect(gmail.scopes.join(" ")).not.toMatch(/gmail\.send/);
  });

  it("authorize returns a system-browser URL with PKCE and signed state", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/connectors/salesforce/authorize",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authorization_url).toContain("code_challenge_method=S256");
    expect(body.authorization_url).toContain("state=");
    expect(body.expires_in_seconds).toBe(600);
  });

  it("full OAuth lifecycle: callback stores an encrypted token, response has NO token", async () => {
    // authorize to mint state + PKCE
    const authRes = await app.inject({
      method: "POST",
      url: "/v1/connectors/salesforce/authorize",
      headers: headers(),
    });
    const url = new URL(authRes.json().authorization_url);
    const state = url.searchParams.get("state")!;

    const cbRes = await app.inject({
      method: "GET",
      url: `/v1/connectors/salesforce/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });
    expect(cbRes.statusCode).toBe(200);
    const body = cbRes.json();
    expect(body.connected).toBe(true);
    expect(body.connector.status).toBe("connected");
    // The token NEVER appears in any client-facing response.
    expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(body)).not.toContain("SECRET_REFRESH");
    expect(body.connector).not.toHaveProperty("access_token");

    // …and it is not readable from /v1/connectors either.
    const listRes = await app.inject({ method: "GET", url: "/v1/connectors", headers: headers() });
    expect(JSON.stringify(listRes.json())).not.toContain(SECRET_TOKEN);
    expect(listRes.json().connected[0].status).toBe("connected");
  });

  it("the encrypted token in the database is not the plaintext", async () => {
    const rows = await client.sql<{ ct: Buffer }[]>`
      SELECT encrypted_token_ciphertext AS ct FROM connector_accounts
      WHERE organization_id = ${orgId} AND provider = 'salesforce'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.ct.toString("utf8")).not.toContain(SECRET_TOKEN);
  });

  it("test endpoint reports health without returning the token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/connectors/salesforce/test",
      headers: headers(),
    });
    expect(res.json()).toEqual({ healthy: true, status: "connected" });
  });

  it("rejects a tampered or expired OAuth state at callback", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/connectors/salesforce/callback?code=x&state=tampered.sig",
    });
    expect(res.statusCode).toBe(400);
  });

  it("disconnect revokes the connector AND pauses dependent agents", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/connectors/salesforce/disconnect",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ disconnected: true, paused_agents: 1 });

    const agentState = await withTenant(client.sql, { organizationId: orgId }, async (tx) => {
      const rows = await tx<{ state: string }[]>`
        SELECT state FROM agents WHERE organization_id = ${orgId}
      `;
      return rows[0]!.state;
    });
    expect(agentState).toBe("paused");
  });
});
