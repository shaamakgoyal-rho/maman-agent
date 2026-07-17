import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@maman/contracts";
import type { ServerEnv } from "@maman/config";
import { buildServer } from "../src/server.js";

const baseEnv: ServerEnv = {
  NODE_ENV: "test",
  AUTH_MODE: "dev",
  MODEL_PROVIDER: "demo",
  CONNECTOR_MODE: "demo",
  DATABASE_URL: "postgres://localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
  DEVICE_TOKEN_SIGNING_SECRET: "x".repeat(43),
  OAUTH_STATE_SIGNING_SECRET: "x".repeat(43),
  CONNECTOR_ENCRYPTION_MASTER_KEY: "x".repeat(43),
};

let app: FastifyInstance;
const userId = uuidv7();
const orgId = uuidv7();

const devHeaders = (role = "member") => ({
  "x-dev-user-id": userId,
  "x-dev-org-id": orgId,
  "x-dev-role": role,
});

beforeAll(async () => {
  app = buildServer({ env: baseEnv });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("production guard", () => {
  it("refuses to build with AUTH_MODE=dev in production", () => {
    expect(() => buildServer({ env: { ...baseEnv, NODE_ENV: "production" } })).toThrow(
      /forbidden in production/,
    );
  });

  it("builds with workos auth in production", () => {
    const prod = buildServer({
      env: {
        ...baseEnv,
        NODE_ENV: "production",
        AUTH_MODE: "workos",
        WORKOS_API_KEY: "sk_test",
        WORKOS_CLIENT_ID: "client",
      },
    });
    expect(prod).toBeTruthy();
  });
});

describe("health", () => {
  it("liveness is process-only", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("authentication", () => {
  it("returns 401 problem details without identity", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.title).toBe("Unauthorized");
    expect(body.request_id).toBeTruthy();
  });

  it("authenticates dev identity headers in dev mode", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: devHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user_id: userId,
      organization_id: orgId,
      role: "member",
      auth_mode: "dev",
    });
  });

  it("rejects an invalid dev role", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: devHeaders("superuser"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("ignores dev identity headers when AUTH_MODE=workos", async () => {
    const workosApp = buildServer({ env: { ...baseEnv, AUTH_MODE: "workos" } });
    await workosApp.ready();
    const res = await workosApp.inject({ method: "GET", url: "/v1/me", headers: devHeaders() });
    expect(res.statusCode).toBe(401);
    await workosApp.close();
  });

  it("rejects a bearer token when WorkOS is unconfigured", async () => {
    const workosApp = buildServer({ env: { ...baseEnv, AUTH_MODE: "workos" } });
    await workosApp.ready();
    const res = await workosApp.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer some-token" },
    });
    expect(res.statusCode).toBe(401);
    await workosApp.close();
  });
});

describe("centralized authorization", () => {
  it("denies member access to the admin overview with 403 problem details", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: devHeaders("member"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("allows org_admin to read the admin overview", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: devHeaders("org_admin"),
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows manager (aggregate-only role) to read the overview", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: devHeaders("manager"),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("problem details and request ids", () => {
  it("unknown routes return 404 problem details", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().title).toBe("Not Found");
  });

  it("propagates x-request-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "req-abc-123" },
    });
    expect(res.headers["x-request-id"]).toBe("req-abc-123");
  });

  it("generates a request id when absent", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});
