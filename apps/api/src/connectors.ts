import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { ServerEnv } from "@maman/config";
import { uuidv7 } from "@maman/contracts";
import {
  buildAuthorizationUrl,
  envelopeEncrypt,
  exchangeCode,
  generatePkce,
  getProvider,
  PROVIDERS,
  signState,
  verifyState,
  type TokenTransport,
} from "@maman/connector-auth";
import {
  disconnectConnector,
  getConnectorSecret,
  listConnectorAccounts,
  upsertConnectorAccount,
} from "@maman/db";
import { requirePrincipal } from "./auth.js";
import { authorize } from "./authorization.js";

/**
 * Connector Broker routes (spec §17 + Capability Mesh). OAuth 2.0 auth-code +
 * PKCE via the system browser. Tokens are envelope-encrypted server-side and
 * NEVER returned to the desktop client or extension — every response is a
 * status view. Disconnect pauses dependent agents.
 */

// PKCE verifiers live server-side keyed by the signed state nonce, cleared on
// callback. In production this is a short-TTL store (Redis); demo uses memory.
const pkceStore = new Map<string, string>();

function realTransport(): TokenTransport {
  return async (tokenEndpoint, form) => {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

export function registerConnectorRoutes(
  app: FastifyInstance,
  deps: { env: ServerEnv; sql?: Sql | undefined; transport?: TokenTransport },
): void {
  const { env } = deps;
  const master = Buffer.from(
    createHash("sha256").update(env.CONNECTOR_ENCRYPTION_MASTER_KEY).digest(),
  );

  app.get("/v1/connectors", { schema: { tags: ["connectors"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    const providers = Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      display_name: p.display_name,
      scopes: p.scopes,
      supports_pkce: p.supports_pkce,
    }));
    if (!deps.sql) return { providers, connected: [] };
    const connected = await listConnectorAccounts(deps.sql, {
      organizationId: principal.organization_id,
    });
    return { providers, connected };
  });

  app.post("/v1/connectors/:provider/authorize", async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "connectors.manage_own").allowed) {
      return reply.status(403).send({ status: 403, title: "Forbidden" });
    }
    const provider = (req.params as { provider: string }).provider;
    const config = getProvider(provider);
    if (!config) return reply.status(404).send({ status: 404 });

    const redirectUri = `${env.API_BASE_URL}/v1/connectors/${provider}/callback`;
    const nonce = uuidv7();
    const state = signState(
      {
        organization_id: principal.organization_id,
        user_id: principal.user_id,
        provider,
        redirect_uri: redirectUri,
        nonce,
        issued_at_ms: Date.now(),
      },
      env.OAUTH_STATE_SIGNING_SECRET,
    );
    let challenge: string | undefined;
    if (config.supports_pkce) {
      const pkce = generatePkce();
      pkceStore.set(nonce, pkce.verifier);
      challenge = pkce.challenge;
    }
    const clientId = clientIdFor(provider, env) ?? "demo-client-id";
    const url = buildAuthorizationUrl({
      provider,
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      ...(challenge ? { pkce_challenge: challenge } : {}),
    });
    // The desktop opens this in the system browser. Tokens never touch it.
    return { authorization_url: url, expires_in_seconds: 600 };
  });

  app.get("/v1/connectors/:provider/callback", async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    const query = req.query as { code?: string; state?: string };
    if (!query.code || !query.state) return reply.status(400).send({ status: 400 });

    const verified = verifyState(query.state, env.OAUTH_STATE_SIGNING_SECRET, Date.now());
    if (!verified.valid) {
      return reply.status(400).send({ status: 400, detail: verified.reason });
    }
    const payload = verified.payload;
    if (payload.provider !== provider) return reply.status(400).send({ status: 400 });
    if (!deps.sql) return reply.status(503).send({ status: 503 });

    const verifier = pkceStore.get(payload.nonce);
    pkceStore.delete(payload.nonce); // single use

    const result = await exchangeCode(
      {
        provider,
        client_id: clientIdFor(provider, env) ?? "demo-client-id",
        ...(clientSecretFor(provider, env)
          ? { client_secret: clientSecretFor(provider, env)! }
          : {}),
        code: query.code,
        redirect_uri: payload.redirect_uri,
        ...(verifier ? { pkce_verifier: verifier } : {}),
      },
      deps.transport ?? realTransport(),
    );
    if (!result.ok) {
      return reply.status(502).send({ status: 502, detail: result.error });
    }

    // Envelope-encrypt and store; the plaintext token dies with this scope.
    const envelope = envelopeEncrypt(
      { access_token: result.tokens.access_token, refresh_token: result.tokens.refresh_token },
      master,
      { organization_id: payload.organization_id, provider },
    );
    const accountHash = createHash("sha256")
      .update(`${payload.organization_id}:${provider}:${result.tokens.access_token}`)
      .digest("hex")
      .slice(0, 32);
    const view = await upsertConnectorAccount(
      deps.sql,
      { organizationId: payload.organization_id },
      {
        id: uuidv7(),
        organization_id: payload.organization_id,
        owner_user_id: payload.user_id,
        provider,
        external_account_id_hash: accountHash,
        display_label: getProvider(provider)!.display_name,
        scopes: getProvider(provider)!.scopes,
        status: "connected",
        encrypted_token_ciphertext: envelope.ciphertext,
        encrypted_data_key: envelope.encrypted_data_key,
        token_key_version: envelope.key_version,
        ...(result.tokens.expires_in
          ? { expires_at: new Date(Date.now() + result.tokens.expires_in * 1000).toISOString() }
          : {}),
        last_verified_at: new Date().toISOString(),
      },
    );
    // Response carries STATUS ONLY — no token.
    return { connected: true, connector: view };
  });

  app.post("/v1/connectors/:provider/disconnect", async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "connectors.manage_own").allowed) {
      return reply.status(403).send({ status: 403 });
    }
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const provider = (req.params as { provider: string }).provider;
    const result = await disconnectConnector(
      deps.sql,
      { organizationId: principal.organization_id },
      provider,
    );
    return result;
  });

  app.post("/v1/connectors/:provider/test", async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return { healthy: false, reason: "database unavailable" };
    const provider = (req.params as { provider: string }).provider;
    const secret = await getConnectorSecret(
      deps.sql,
      { organizationId: principal.organization_id },
      provider,
    );
    // Health is derived from stored metadata; the token is never returned.
    if (!secret) return { healthy: false, reason: "not connected" };
    return { healthy: secret.status === "connected", status: secret.status };
  });
}

function clientIdFor(provider: string, env: ServerEnv): string | undefined {
  if (provider === "salesforce") return env.SALESFORCE_CLIENT_ID;
  if (provider.startsWith("google") || provider === "gmail") return env.GOOGLE_CLIENT_ID;
  return undefined;
}
function clientSecretFor(provider: string, env: ServerEnv): string | undefined {
  if (provider === "salesforce") return env.SALESFORCE_CLIENT_SECRET;
  if (provider.startsWith("google") || provider === "gmail") return env.GOOGLE_CLIENT_SECRET;
  return undefined;
}
