import { describe, expect, it } from "vitest";
import { EnvValidationError, loadServerEnv } from "../src/env.js";

const validDev: Record<string, string> = {
  NODE_ENV: "development",
  AUTH_MODE: "dev",
  MODEL_PROVIDER: "demo",
  CONNECTOR_MODE: "demo",
  DATABASE_URL: "postgres://maman:x@localhost:5432/maman",
  REDIS_URL: "redis://localhost:6379",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
  DEVICE_TOKEN_SIGNING_SECRET: "a".repeat(43),
  OAUTH_STATE_SIGNING_SECRET: "b".repeat(43),
  CONNECTOR_ENCRYPTION_MASTER_KEY: "c".repeat(43),
};

describe("loadServerEnv", () => {
  it("accepts a valid development environment", () => {
    const env = loadServerEnv(validDev);
    expect(env.NODE_ENV).toBe("development");
    expect(env.AUTH_MODE).toBe("dev");
  });

  it("rejects AUTH_MODE=dev in production", () => {
    expect(() => loadServerEnv({ ...validDev, NODE_ENV: "production" })).toThrow(
      EnvValidationError,
    );
  });

  it("accepts production with workos auth configured", () => {
    const env = loadServerEnv({
      ...validDev,
      NODE_ENV: "production",
      AUTH_MODE: "workos",
      WORKOS_API_KEY: "sk_test_workos",
      WORKOS_CLIENT_ID: "client_123",
    });
    expect(env.AUTH_MODE).toBe("workos");
  });

  it("rejects production workos auth without credentials", () => {
    expect(() =>
      loadServerEnv({ ...validDev, NODE_ENV: "production", AUTH_MODE: "workos" }),
    ).toThrow(EnvValidationError);
  });

  it("rejects production anthropic provider without an API key", () => {
    expect(() =>
      loadServerEnv({
        ...validDev,
        NODE_ENV: "production",
        AUTH_MODE: "workos",
        WORKOS_API_KEY: "sk_test_workos",
        WORKOS_CLIENT_ID: "client_123",
        MODEL_PROVIDER: "anthropic",
      }),
    ).toThrow(EnvValidationError);
  });

  it("rejects short signing secrets", () => {
    expect(() => loadServerEnv({ ...validDev, DEVICE_TOKEN_SIGNING_SECRET: "short" })).toThrow(
      EnvValidationError,
    );
  });

  it("treats empty strings as absent", () => {
    const env = loadServerEnv({ ...validDev, ANTHROPIC_API_KEY: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL: _omitted, ...rest } = validDev;
    expect(() => loadServerEnv(rest)).toThrow(EnvValidationError);
  });

  // M18: the four-edit live trial fails fast on a half-set pair (any env).
  it("rejects MODEL_PROVIDER=anthropic without a key even in development", () => {
    expect(() => loadServerEnv({ ...validDev, MODEL_PROVIDER: "anthropic" })).toThrow(
      EnvValidationError,
    );
  });

  it("accepts CONNECTOR_MODE=real with a complete Salesforce triple", () => {
    const env = loadServerEnv({
      ...validDev,
      CONNECTOR_MODE: "real",
      SALESFORCE_CLIENT_ID: "sf_id",
      SALESFORCE_CLIENT_SECRET: "sf_secret",
      SALESFORCE_REDIRECT_URI: "http://localhost:4000/v1/connectors/salesforce/callback",
    });
    expect(env.CONNECTOR_MODE).toBe("real");
  });

  it("rejects CONNECTOR_MODE=real with no Salesforce credentials", () => {
    expect(() => loadServerEnv({ ...validDev, CONNECTOR_MODE: "real" })).toThrow(
      EnvValidationError,
    );
  });

  it("rejects a half-set Salesforce triple", () => {
    expect(() =>
      loadServerEnv({ ...validDev, CONNECTOR_MODE: "real", SALESFORCE_CLIENT_ID: "only_id" }),
    ).toThrow(EnvValidationError);
  });

  it("rejects half-set Google credentials", () => {
    expect(() => loadServerEnv({ ...validDev, GOOGLE_CLIENT_ID: "only_id" })).toThrow(
      EnvValidationError,
    );
  });
});
