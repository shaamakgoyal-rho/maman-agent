import type { Sql } from "postgres";
import {
  envelopeDecrypt,
  envelopeEncrypt,
  refreshTokens,
  type EnvelopeCiphertext,
  type TokenTransport,
} from "@maman/connector-auth";
import { getConnectorSecret, updateConnectorTokens } from "@maman/db";
import { PermanentAdapterError } from "@maman/agent-runtime";
import type { CredentialProvider, ProviderCredentials } from "@maman/connector-adapters";

/**
 * Vault-backed credential provider for the worker. Tokens live only here,
 * server-side: loaded from the envelope-encrypted `connector_accounts` vault,
 * decrypted in-process, handed to the adapter as a Bearer header, and NEVER
 * returned to any caller, written into an AgentSpec/output, or logged. Refresh
 * uses the connector-auth refresh path and re-persists the re-encrypted token.
 */

export type VaultCredentialDeps = {
  sql: Sql;
  masterKey: Buffer;
  transport: TokenTransport;
  clientCredentials: (provider: string) => { client_id: string; client_secret?: string } | null;
};

type StoredToken = {
  access_token: string;
  refresh_token?: string;
  instance_url?: string;
  scope?: string;
};

export function createVaultCredentialProvider(deps: VaultCredentialDeps): CredentialProvider {
  async function loadStored(
    organizationId: string,
    provider: string,
  ): Promise<{ token: StoredToken; envelope: EnvelopeCiphertext } | null> {
    const secret = await getConnectorSecret(deps.sql, { organizationId }, provider);
    if (!secret || secret.status === "revoked") return null;
    const envelope: EnvelopeCiphertext = {
      ciphertext: secret.ciphertext,
      encrypted_data_key: secret.encrypted_data_key,
      key_version: secret.key_version,
    };
    const token = envelopeDecrypt(envelope, deps.masterKey, {
      organization_id: organizationId,
      provider,
    }) as StoredToken;
    return { token, envelope };
  }

  return {
    async load({ organization_id, provider }): Promise<ProviderCredentials | null> {
      const stored = await loadStored(organization_id, provider);
      if (!stored) return null;
      return toCredentials(stored.token);
    },

    async refresh({ organization_id, provider }): Promise<ProviderCredentials> {
      const stored = await loadStored(organization_id, provider);
      if (!stored?.token.refresh_token) {
        throw new PermanentAdapterError(`${provider}: no refresh token available`);
      }
      const client = deps.clientCredentials(provider);
      if (!client) {
        throw new PermanentAdapterError(`${provider}: connector client not configured`);
      }
      const result = await refreshTokens(
        {
          provider,
          client_id: client.client_id,
          ...(client.client_secret ? { client_secret: client.client_secret } : {}),
          refresh_token: stored.token.refresh_token,
        },
        deps.transport,
      );
      if (!result.ok) {
        throw new PermanentAdapterError(`${provider}: token refresh failed (${result.error})`);
      }
      const raw = result.tokens as typeof result.tokens & { instance_url?: string };
      // A refresh response may omit fields — keep the prior value for each.
      const refreshToken = result.tokens.refresh_token ?? stored.token.refresh_token;
      const instanceUrl = raw.instance_url ?? stored.token.instance_url;
      const scope = result.tokens.scope ?? stored.token.scope;
      const next: StoredToken = {
        access_token: result.tokens.access_token,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        ...(instanceUrl ? { instance_url: instanceUrl } : {}),
        ...(scope ? { scope } : {}),
      };
      const envelope = envelopeEncrypt(next as Record<string, unknown>, deps.masterKey, {
        organization_id,
        provider,
      });
      await updateConnectorTokens(
        deps.sql,
        { organizationId: organization_id },
        {
          provider,
          ciphertext: envelope.ciphertext,
          encrypted_data_key: envelope.encrypted_data_key,
          key_version: envelope.key_version,
          expires_at: result.tokens.expires_in
            ? new Date(Date.now() + result.tokens.expires_in * 1000).toISOString()
            : null,
        },
      );
      return toCredentials(next);
    },
  };
}

function toCredentials(token: StoredToken): ProviderCredentials {
  return {
    access_token: token.access_token,
    ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
    ...(token.instance_url ? { instance_url: token.instance_url } : {}),
    ...(token.scope ? { scope: token.scope } : {}),
  };
}
