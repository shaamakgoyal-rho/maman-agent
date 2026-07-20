import { PermanentAdapterError, TransientAdapterError } from "@maman/agent-runtime";

/**
 * Credential access for real connector adapters. Tokens are loaded from the
 * server-side envelope-encrypted vault at run time and NEVER serialized into an
 * AgentSpec, log line, prompt, or client response. A `CredentialProvider` is
 * the only surface an adapter has to the vault; it can refresh + re-persist.
 */

export type ProviderCredentials = {
  access_token: string;
  refresh_token?: string;
  /** Salesforce returns a per-org instance URL alongside the token. */
  instance_url?: string;
  scope?: string;
  expires_at?: string;
};

export interface CredentialProvider {
  /** Current credentials for org+provider, or null when no connector is linked. */
  load(input: { organization_id: string; provider: string }): Promise<ProviderCredentials | null>;
  /** Refresh + persist; throws PermanentAdapterError when refresh is impossible. */
  refresh(input: { organization_id: string; provider: string }): Promise<ProviderCredentials>;
}

/**
 * Single-write idempotency ledger. The demo/default is in-memory; the worker
 * injects a DB-backed store (unique run_steps.idempotency_key) so a worker
 * restart mid-write never double-applies.
 */
export interface IdempotencyStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, unknown>();
  async get(key: string): Promise<unknown | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

/**
 * Maps an HTTP status to the adapter fault taxonomy the run engine understands:
 * transient (retry within the step budget) vs. permanent (no retry).
 * - 401 is handled by the caller (refresh + one retry) before reaching here.
 * - 429 / 408 / 5xx → transient. 4xx (except 401) → permanent.
 */
export function throwForStatus(capability: string, status: number, detail?: string): never {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 429 || status === 408 || status >= 500) {
    throw new TransientAdapterError(`${capability}: provider ${status}${suffix}`);
  }
  throw new PermanentAdapterError(`${capability}: provider ${status}${suffix}`);
}

/** A network-layer failure (no HTTP status) is retry-safe. */
export function throwTransientNetwork(capability: string, cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause);
  throw new TransientAdapterError(`${capability}: network error: ${message}`);
}
