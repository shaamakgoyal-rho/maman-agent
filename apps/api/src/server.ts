import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifySwagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import {
  agentSpecSchema,
  deviceRegisterRequestSchema,
  principalSchema,
  syncBatchRequestSchema,
  SYNC_MAX_BATCH_SIZE,
  uuidv7,
  type Principal,
} from "@maman/contracts";
import type { ServerEnv } from "@maman/config";
import type { Sql } from "postgres";
import {
  createAuthenticator,
  CompositeAuthenticator,
  DeviceTokenAuthenticator,
  requirePrincipal,
  type Authenticator,
} from "./auth.js";
import { authorize } from "./authorization.js";
import { adminAudit, adminOverview, engageKillSwitch, getAgentById } from "./admin.js";
import {
  createDeviceSession,
  deviceSessionActive,
  ingestSyncedEvents,
  persistCompiledAgent,
  revokeDeviceSessionByToken,
  upsertDevice,
} from "@maman/db";
import { DEVICE_TOKEN_TTL_MS, signDeviceToken } from "./device-token.js";
import { registerConnectorRoutes } from "./connectors.js";
import type { TokenTransport } from "@maman/connector-auth";

const SYNC_MIN_INTERVAL_SECONDS = 30;
const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export type ServerDeps = {
  env: ServerEnv;
  sql?: Sql | undefined;
  authenticator?: Authenticator;
  /** Injectable OAuth token transport (tests supply a mock provider). */
  connectorTransport?: TokenTransport;
};

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Builds the Fastify API server.
 * Hard guard: refuses to construct with AUTH_MODE=dev in production — this is
 * enforced in env validation too; defense in depth is intentional.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { env } = deps;
  if (env.NODE_ENV === "production" && env.AUTH_MODE === "dev") {
    throw new Error("FATAL: AUTH_MODE=dev is forbidden in production.");
  }

  // Device tokens are accepted first (desktop app), then the user authenticator.
  // With a DB present, revocation/rotation is authoritative via a session check.
  const sql = deps.sql;
  const deviceAuth = new DeviceTokenAuthenticator(
    env.DEVICE_TOKEN_SIGNING_SECRET,
    sql
      ? ({ organization_id, token_sha256 }) =>
          deviceSessionActive(sql, { organizationId: organization_id }, token_sha256)
      : undefined,
  );
  const authenticator = new CompositeAuthenticator(
    deviceAuth,
    deps.authenticator ?? createAuthenticator(env),
  );

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "*.token",
          "*.secret",
          "*.password",
          "*.refresh_token",
          "*.access_token",
        ],
        censor: "[REDACTED]",
      },
    },
    // X-Request-Id: propagate or generate.
    genReqId: (req) =>
      (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"]) ||
      randomUUID(),
    bodyLimit: 1024 * 1024, // 1 MB JSON body limit (connector callbacks get a larger override later)
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // RFC 9457 problem details for every error response.
  app.setErrorHandler((error: FastifyError, req, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: error }, "request failed");
    void reply
      .status(status)
      .header("content-type", "application/problem+json")
      .send({
        type: "about:blank",
        title: status >= 500 ? "Internal Server Error" : error.message,
        status,
        ...(status < 500 && error.message ? { detail: error.message } : {}),
        request_id: req.id,
      });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).header("content-type", "application/problem+json").send({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      request_id: req.id,
    });
  });

  // Response header with the request id for tracing.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  // Authentication hook: attaches req.principal when credentials are valid.
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const principal = await authenticator.authenticate(req);
    if (principal) req.principal = principal;
  });

  void app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Maman API",
        description: "Tenant-isolated API for the Maman agent platform.",
        version: "0.1.0",
      },
      servers: [{ url: env.API_BASE_URL }],
    },
    transform: jsonSchemaTransform,
  });

  // ---- health ----
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (req, reply) => {
    if (!deps.sql) return { status: "ok", checks: { database: "not_configured" } };
    try {
      await deps.sql`SELECT 1`;
      return { status: "ok", checks: { database: "ok" } };
    } catch {
      return reply.status(503).send({ status: "unavailable", checks: { database: "failed" } });
    }
  });

  // Dev-only helper so local tools (the admin console) can resolve the seeded
  // org UUID from its WorkOS id. Registered ONLY in AUTH_MODE=dev.
  if (env.AUTH_MODE === "dev") {
    app.get("/v1/dev/resolve-org", async (req, reply) => {
      const workosId = (req.query as { workos_id?: string }).workos_id;
      if (!deps.sql || !workosId) return reply.status(404).send({ status: 404 });
      const rows = await deps.sql<{ id: string }[]>`
        SELECT id FROM organizations WHERE workos_organization_id = ${workosId}
      `;
      if (rows.length === 0) return reply.status(404).send({ status: 404 });
      return { organization_id: rows[0]!.id };
    });
  }

  // ---- v1 ----
  app.get(
    "/v1/me",
    {
      schema: {
        response: { 200: principalSchema, 401: z.any() },
        tags: ["identity"],
      },
    },
    async (req, reply) => {
      const principal = await requirePrincipal(req, reply);
      if (!principal) return;
      return principal;
    },
  );

  // Reference implementation of the centralized authorization pattern for all
  // future admin routes; returns 403 problem details on role denial.
  const forbid = (req: FastifyRequest, reply: FastifyReply, detail: string) =>
    reply.status(403).header("content-type", "application/problem+json").send({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail,
      request_id: req.id,
    });

  app.get("/v1/admin/overview", { schema: { tags: ["admin"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "org.overview.read").allowed) {
      return forbid(req, reply, "Role is not permitted to read the organization overview.");
    }
    if (!deps.sql) return { organization_id: principal.organization_id, unavailable: true };
    return adminOverview(deps.sql, principal.organization_id);
  });

  app.get("/v1/admin/audit", { schema: { tags: ["admin"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "org.audit.read").allowed) {
      return forbid(req, reply, "Role is not permitted to read the audit log.");
    }
    if (!deps.sql) return [];
    return adminAudit(deps.sql, principal.organization_id, 100);
  });

  app.get("/v1/agents/:id", { schema: { tags: ["agents"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "agents.read_own").allowed) {
      return forbid(req, reply, "Role is not permitted to read agents.");
    }
    if (!deps.sql) return reply.status(404).send({ status: 404 });
    const agentId = (req.params as { id: string }).id;
    const agent = await getAgentById(
      deps.sql,
      { organizationId: principal.organization_id },
      agentId,
    );
    if (!agent) {
      // Cross-tenant or missing — both return 404, never 403 (no existence leak).
      return reply.status(404).header("content-type", "application/problem+json").send({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "Agent not found.",
        request_id: req.id,
      });
    }
    return agent;
  });

  // Persist a client-compiled AgentSpec server-side (agent + immutable version).
  app.post("/v1/agents", { schema: { tags: ["agents"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "agents.write_own").allowed) {
      return forbid(req, reply, "Role is not permitted to create agents.");
    }
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const body = z
      .object({ spec: agentSpecSchema, policy_version_id: z.string().uuid().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.status(400).send({ status: 400, title: "Invalid agent spec" });
    const spec = body.data.spec;
    // Tenant binding: the spec must belong to the caller's org (never trust the body).
    if (spec.organization_id !== principal.organization_id) {
      return reply.status(400).send({ status: 400, title: "Spec org mismatch" });
    }
    const result = await persistCompiledAgent(
      deps.sql,
      { organizationId: principal.organization_id },
      {
        spec,
        spec_sha256: sha256Hex(JSON.stringify(spec)),
        policy_version_id: body.data.policy_version_id ?? uuidv7(),
      },
    );
    return result;
  });

  // Kill switch: any org member can halt everything for their org; an admin
  // halts the whole org. Deterministic, audited, and idempotent.
  app.post("/v1/admin/kill-switch", { schema: { tags: ["admin"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "agents.write_own").allowed) {
      return forbid(req, reply, "Role is not permitted to engage the kill switch.");
    }
    if (!deps.sql) return { paused_agents: 0, halted_runs: 0, unavailable: true };
    return engageKillSwitch(
      deps.sql,
      { organizationId: principal.organization_id },
      principal.user_id,
    );
  });

  // ---- device enrollment + sync (desktop ↔ API) ----

  // Enroll a device: an authenticated USER session exchanges device metadata for
  // a scoped, HMAC-signed device token. The desktop stores it in the OS keychain.
  app.post("/v1/devices/enroll", { schema: { tags: ["devices"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (principal.auth_mode === "device") {
      return forbid(req, reply, "Re-enroll from a user session, or rotate the device token.");
    }
    if (!authorize(principal, "devices.manage_own").allowed) {
      return forbid(req, reply, "Role is not permitted to enroll a device.");
    }
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const parsed = deviceRegisterRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ status: 400, title: "Bad Request" });

    const ctx = { organizationId: principal.organization_id };
    const deviceId = await upsertDevice(deps.sql, ctx, {
      device_id: uuidv7(),
      owner_user_id: principal.user_id,
      device_public_id: parsed.data.device_public_id,
      platform: parsed.data.platform,
      app_version: parsed.data.app_version,
      observer_version: parsed.data.observer_version,
      capabilities: parsed.data.capabilities,
    });
    const now = Date.now();
    const expiresAtMs = now + DEVICE_TOKEN_TTL_MS;
    const tokenFamilyId = uuidv7();
    const token = signDeviceToken(
      {
        device_id: deviceId,
        organization_id: principal.organization_id,
        user_id: principal.user_id,
        role: principal.role,
        token_family_id: tokenFamilyId,
        issued_at_ms: now,
        expires_at_ms: expiresAtMs,
      },
      env.DEVICE_TOKEN_SIGNING_SECRET,
    );
    const expiresAt = new Date(expiresAtMs).toISOString();
    await createDeviceSession(deps.sql, ctx, {
      session_id: uuidv7(),
      user_id: principal.user_id,
      device_id: deviceId,
      token_family_id: tokenFamilyId,
      token_sha256: sha256Hex(token),
      expires_at: expiresAt,
    });
    return {
      device_id: deviceId,
      device_token: token,
      device_token_expires_at: expiresAt,
      sync_policy: {
        max_batch_size: SYNC_MAX_BATCH_SIZE,
        min_sync_interval_seconds: SYNC_MIN_INTERVAL_SECONDS,
      },
      server_time: new Date(now).toISOString(),
    };
  });

  // Rotate a device token: the current device token is revoked and a new one is
  // issued in the same token family.
  app.post("/v1/devices/rotate", { schema: { tags: ["devices"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (principal.auth_mode !== "device" || !principal.device_id) {
      return forbid(req, reply, "Rotation requires the current device token.");
    }
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const header = req.headers.authorization ?? "";
    const currentToken = header.slice("Bearer ".length);
    const ctx = { organizationId: principal.organization_id };
    const revoked = await revokeDeviceSessionByToken(deps.sql, ctx, sha256Hex(currentToken));
    if (!revoked) {
      return reply.status(409).send({ status: 409, title: "Session already rotated or revoked" });
    }
    const now = Date.now();
    const expiresAtMs = now + DEVICE_TOKEN_TTL_MS;
    const token = signDeviceToken(
      {
        device_id: principal.device_id,
        organization_id: principal.organization_id,
        user_id: principal.user_id,
        role: principal.role,
        token_family_id: revoked.token_family_id,
        issued_at_ms: now,
        expires_at_ms: expiresAtMs,
      },
      env.DEVICE_TOKEN_SIGNING_SECRET,
    );
    const expiresAt = new Date(expiresAtMs).toISOString();
    await createDeviceSession(deps.sql, ctx, {
      session_id: uuidv7(),
      user_id: principal.user_id,
      device_id: principal.device_id,
      token_family_id: revoked.token_family_id,
      token_sha256: sha256Hex(token),
      expires_at: expiresAt,
      rotated_from_session_id: revoked.id,
    });
    return {
      device_token: token,
      device_token_expires_at: expiresAt,
      server_time: new Date(now).toISOString(),
    };
  });

  // Sync: the device uploads redacted, identity-safe projections. The strict
  // contract rejects any raw-event shape; dedupe is on (org, event_id).
  app.post("/v1/sync/events", { schema: { tags: ["sync"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (principal.auth_mode !== "device" || !principal.device_id) {
      return forbid(req, reply, "Event sync requires a device token.");
    }
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const parsed = syncBatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // A rejected batch means a raw/oversized shape tried to leave the device.
      return reply.status(400).send({ status: 400, title: "Invalid sync projection" });
    }
    const result = await ingestSyncedEvents(
      deps.sql,
      { organizationId: principal.organization_id },
      {
        device_id: principal.device_id,
        owner_user_id: principal.user_id,
        events: parsed.data.events.map((e) => ({
          event_id: e.event_id,
          occurred_at: e.occurred_at,
          source: e.source,
          app_category: e.app_category,
          event_type: e.event_type,
          sensitivity: e.sensitivity,
          excluded_from_learning: e.excluded_from_learning,
          projection: e,
        })),
      },
    );
    return { ...result, server_time: new Date().toISOString() };
  });

  registerConnectorRoutes(app, {
    env,
    sql: deps.sql,
    ...(deps.connectorTransport ? { transport: deps.connectorTransport } : {}),
  });

  // There is deliberately NO endpoint returning another member's raw events,
  // screen content, or a productivity ranking. `roi/me` is self-scoped only.
  app.get("/v1/roi/me", { schema: { tags: ["roi"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "roi.read_own").allowed) {
      return forbid(req, reply, "Role is not permitted to read personal ROI.");
    }
    return { user_id: principal.user_id, verified_hours: 0, net_value_usd: null };
  });

  return app;
}
