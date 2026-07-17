/**
 * Generates docs/api/openapi.json from the live route definitions.
 * `--check` fails when the committed document drifts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";
import type { ServerEnv } from "@maman/config";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "..", "..", "docs", "api", "openapi.json");

const env: ServerEnv = {
  NODE_ENV: "test",
  AUTH_MODE: "dev",
  MODEL_PROVIDER: "demo",
  CONNECTOR_MODE: "demo",
  DATABASE_URL: "postgres://localhost:5432/openapi_codegen",
  REDIS_URL: "redis://localhost:6379",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
  DEVICE_TOKEN_SIGNING_SECRET: "x".repeat(43),
  OAUTH_STATE_SIGNING_SECRET: "x".repeat(43),
  CONNECTOR_ENCRYPTION_MASTER_KEY: "x".repeat(43),
};

const app = buildServer({ env });
await app.ready();
const doc = `${JSON.stringify(app.swagger(), null, 2)}\n`;
await app.close();

if (process.argv.includes("--check")) {
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (existing !== doc) {
    console.error("OpenAPI drift detected. Run `pnpm openapi:generate` and commit.");
    process.exit(1);
  }
  console.log("openapi.json matches routes");
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, doc);
  console.log(`wrote ${outPath}`);
}
