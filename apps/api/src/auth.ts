import type { FastifyReply, FastifyRequest } from "fastify";
import { principalSchema, type Principal } from "@maman/contracts";
import type { ServerEnv } from "@maman/config";

/**
 * Authentication strategies behind a single interface.
 *
 * - dev:    identity headers, accepted ONLY when AUTH_MODE=dev (which itself is
 *           refused when NODE_ENV=production by env validation AND by an
 *           explicit guard in buildServer).
 * - workos: Bearer token verification through the WorkOS adapter. The adapter
 *           interface is complete; live verification activates when WorkOS
 *           credentials are configured.
 */

export interface Authenticator {
  authenticate(req: FastifyRequest): Promise<Principal | null>;
  readonly mode: "dev" | "workos";
}

export class DevAuthenticator implements Authenticator {
  readonly mode = "dev" as const;

  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    const userId = req.headers["x-dev-user-id"];
    const orgId = req.headers["x-dev-org-id"];
    const role = req.headers["x-dev-role"] ?? "member";
    if (typeof userId !== "string" || typeof orgId !== "string" || typeof role !== "string") {
      return null;
    }
    const parsed = principalSchema.safeParse({
      user_id: userId,
      organization_id: orgId,
      role,
      auth_mode: "dev",
    });
    return parsed.success ? parsed.data : null;
  }
}

/** Verifies WorkOS AuthKit-issued sessions. */
export interface WorkosTokenVerifier {
  verifyAccessToken(token: string): Promise<{
    workos_user_id: string;
    workos_organization_id: string;
  } | null>;
}

export interface WorkosIdentityResolver {
  resolvePrincipal(identity: {
    workos_user_id: string;
    workos_organization_id: string;
  }): Promise<Principal | null>;
}

export class WorkosAuthenticator implements Authenticator {
  readonly mode = "workos" as const;

  constructor(
    private readonly verifier: WorkosTokenVerifier,
    private readonly resolver: WorkosIdentityResolver,
  ) {}

  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const identity = await this.verifier.verifyAccessToken(token);
    if (!identity) return null;
    return this.resolver.resolvePrincipal(identity);
  }
}

/** Placeholder verifier used until WORKOS_API_KEY is configured: rejects everything. */
export class UnconfiguredWorkosVerifier implements WorkosTokenVerifier {
  async verifyAccessToken(): Promise<null> {
    return null;
  }
}

export function createAuthenticator(
  env: ServerEnv,
  deps?: { verifier?: WorkosTokenVerifier; resolver?: WorkosIdentityResolver },
): Authenticator {
  if (env.AUTH_MODE === "dev") {
    return new DevAuthenticator();
  }
  const verifier = deps?.verifier ?? new UnconfiguredWorkosVerifier();
  const resolver =
    deps?.resolver ??
    ({
      resolvePrincipal: async () => null,
    } satisfies WorkosIdentityResolver);
  return new WorkosAuthenticator(verifier, resolver);
}

export async function requirePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal | null> {
  const principal = (req as FastifyRequest & { principal?: Principal }).principal;
  if (!principal) {
    await reply.status(401).send({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required.",
      request_id: req.id,
    });
    return null;
  }
  return principal;
}
