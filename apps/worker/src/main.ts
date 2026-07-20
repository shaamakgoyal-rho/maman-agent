import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker, NativeConnection } from "@temporalio/worker";
import { loadServerEnv } from "@maman/config";
import {
  DemoSalesforceWorld,
  demoAdapterRegistry,
  type CapabilityAdapter,
} from "@maman/agent-runtime";
import { MemoryIdempotencyStore, realAdapterRegistry } from "@maman/connector-adapters";
import { createDbClient } from "@maman/db";
import { createConnectorTokenTransport } from "@maman/connector-auth";
import { createActivities, type PersistenceSink } from "./activities.js";
import { createVaultCredentialProvider } from "./vault-credentials.js";

/**
 * Temporal worker process. Registers agentRunWorkflow and the activity
 * implementations. In demo mode the persistence sink logs sanitized events;
 * the API owns the authoritative DB writes it receives over its own routes.
 *
 * CONNECTOR_MODE selects the capability registry: `demo` uses the deterministic
 * in-process adapters; `real` uses live connectors (vault tokens) and falls
 * back per capability to the demo adapter when an org has no linked connector.
 */

const env = loadServerEnv(process.env);
const require = createRequire(import.meta.url);

/** Builds the capability registry for the worker per CONNECTOR_MODE. */
function buildRegistry(): Map<string, CapabilityAdapter> {
  const demo = demoAdapterRegistry(new DemoSalesforceWorld());
  if (env.CONNECTOR_MODE !== "real") return demo;

  const { sql } = createDbClient(env.DATABASE_URL);
  const masterKey = createHash("sha256").update(env.CONNECTOR_ENCRYPTION_MASTER_KEY).digest();
  const credentials = createVaultCredentialProvider({
    sql,
    masterKey,
    transport: createConnectorTokenTransport(),
    clientCredentials: (provider) => {
      if (provider === "salesforce" && env.SALESFORCE_CLIENT_ID) {
        return {
          client_id: env.SALESFORCE_CLIENT_ID,
          ...(env.SALESFORCE_CLIENT_SECRET ? { client_secret: env.SALESFORCE_CLIENT_SECRET } : {}),
        };
      }
      if (provider === "google_sheets" && env.GOOGLE_CLIENT_ID) {
        return {
          client_id: env.GOOGLE_CLIENT_ID,
          ...(env.GOOGLE_CLIENT_SECRET ? { client_secret: env.GOOGLE_CLIENT_SECRET } : {}),
        };
      }
      return null;
    },
  });
  return realAdapterRegistry({
    credentials,
    demoFallback: demo,
    idempotency: new MemoryIdempotencyStore(),
  });
}

const sink: PersistenceSink = {
  runStatus: (runId, status) => {
    console.warn(JSON.stringify({ evt: "run_status", run_id: runId, status }));
  },
  stepResult: (runId, summary) => {
    console.warn(
      JSON.stringify({
        evt: "step_result",
        run_id: runId,
        step: summary.step_id,
        status: summary.status,
      }),
    );
  },
  approvalRequested: (input) => {
    console.warn(
      JSON.stringify({ evt: "approval_requested", run_id: input.runId, step: input.stepId }),
    );
  },
  receipt: (receipt) => {
    console.warn(JSON.stringify({ evt: "receipt", receipt }));
  },
};

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: "maman-agent-runs",
    workflowsPath: require.resolve("@maman/agent-runtime/workflow"),
    activities: createActivities({
      registry: buildRegistry(),
      sink,
      now: () => new Date(),
    }),
  });
  console.warn(JSON.stringify({ evt: "worker_ready", queue: "maman-agent-runs" }));
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
