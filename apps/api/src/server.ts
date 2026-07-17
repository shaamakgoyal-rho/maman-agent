import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import fastifySwagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { principalSchema, type Principal } from "@maman/contracts";
import type { ServerEnv } from "@maman/config";
import type { Sql } from "postgres";
import { createAuthenticator, requirePrincipal, type Authenticator } from "./auth.js";
import { authorize } from "./authorization.js";

export type ServerDeps = {
  env: ServerEnv;
  sql?: Sql | undefined;
  authenticator?: Authenticator;
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

  const authenticator = deps.authenticator ?? createAuthenticator(env);

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
  app.get("/v1/admin/overview", { schema: { tags: ["admin"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    const decision = authorize(principal, "org.overview.read");
    if (!decision.allowed) {
      return reply.status(403).header("content-type", "application/problem+json").send({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "Role is not permitted to read the organization overview.",
        request_id: req.id,
      });
    }
    // Aggregates land at M9; the authorization surface exists now.
    return { organization_id: principal.organization_id, cards: [] };
  });

  return app;
}
