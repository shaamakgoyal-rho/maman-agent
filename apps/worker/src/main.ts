import { createRequire } from "node:module";
import { Worker, NativeConnection } from "@temporalio/worker";
import { loadServerEnv } from "@maman/config";
import { DemoSalesforceWorld } from "@maman/agent-runtime";
import { createActivities, type PersistenceSink } from "./activities.js";

/**
 * Temporal worker process. Registers agentRunWorkflow and the activity
 * implementations. In demo mode the persistence sink logs sanitized events;
 * the API owns the authoritative DB writes it receives over its own routes.
 */

const env = loadServerEnv(process.env);
const require = createRequire(import.meta.url);

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
      world: new DemoSalesforceWorld(),
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
