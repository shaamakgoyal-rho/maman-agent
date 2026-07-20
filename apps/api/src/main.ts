import { Client, Connection } from "@temporalio/client";
import { loadServerEnv } from "@maman/config";
import { createDbClient } from "@maman/db";
import { buildServer } from "./server.js";
import { TemporalRunOrchestrator } from "./orchestrator.js";

const env = loadServerEnv(process.env);
const db = createDbClient(env.DATABASE_URL);

// Lazy Temporal connection: the API boots without Temporal reachable; the
// connection is established on the first run/approval call. Run routes return
// 503 until a client is available.
const temporalClient = new Client({
  connection: Connection.lazy({ address: env.TEMPORAL_ADDRESS }),
  namespace: env.TEMPORAL_NAMESPACE,
});
const app = buildServer({
  env,
  sql: db.sql,
  orchestrator: new TemporalRunOrchestrator(temporalClient.workflow),
});

const url = new URL(env.API_BASE_URL);
const port = Number(url.port || 4000);

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
