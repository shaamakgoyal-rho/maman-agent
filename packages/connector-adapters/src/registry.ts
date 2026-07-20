import {
  proposeFieldUpdatesFromMatches,
  pureReconciliationAdapters,
  type CapabilityAdapter,
  type CapabilityContext,
  type MatchResult,
} from "@maman/agent-runtime";
import {
  MemoryIdempotencyStore,
  type CredentialProvider,
  type IdempotencyStore,
} from "./credentials.js";
import { fetchTransport, type HttpTransport } from "./http.js";
import { salesforceCapabilities } from "./salesforce.js";
import { googleSheetsCapabilities } from "./google-sheets.js";

/**
 * Real connector registry. Pure reconciliation steps and the field-diff run
 * locally; provider capabilities use live connectors. Per capability, per org:
 * when no connector is linked for the caller's org, a Salesforce capability
 * falls back to the deterministic demo adapter so a run is never blocked and
 * NEVER silently escalates from a failed API write to an unapproved path.
 *
 * Shadow runs remain write-impossible by construction: the run engine returns
 * before dispatching any `write` in shadow mode, in both demo and real modes.
 */

export type RealRegistryConfig = {
  credentials: CredentialProvider;
  /** Demo registry used as the per-capability fallback (Salesforce recipe). */
  demoFallback: Map<string, CapabilityAdapter>;
  transport?: HttpTransport;
  idempotency?: IdempotencyStore;
};

/** Delegates each method to the real adapter when the org has the connector linked, else demo. */
function withPerOrgFallback(
  provider: string,
  real: CapabilityAdapter,
  demo: CapabilityAdapter | undefined,
  credentials: CredentialProvider,
): CapabilityAdapter {
  const linked = (ctx: CapabilityContext) =>
    credentials.load({ organization_id: ctx.organization_id, provider }).then((c) => c !== null);

  const adapter: CapabilityAdapter = { id: real.id };
  if (real.read || demo?.read) {
    adapter.read = async (inputs, ctx) => {
      const use = (await linked(ctx)) ? real : (demo ?? real);
      if (!use.read) throw new Error(`${real.id}: no read implementation`);
      return use.read(inputs, ctx);
    };
  }
  if (real.proposeWrite || demo?.proposeWrite) {
    adapter.proposeWrite = async (inputs, ctx) => {
      const use = (await linked(ctx)) ? real : (demo ?? real);
      if (!use.proposeWrite) throw new Error(`${real.id}: no proposeWrite implementation`);
      return use.proposeWrite(inputs, ctx);
    };
  }
  if (real.write || demo?.write) {
    adapter.write = async (inputs, diff, ctx, key) => {
      const use = (await linked(ctx)) ? real : (demo ?? real);
      if (!use.write) throw new Error(`${real.id}: no write implementation`);
      return use.write(inputs, diff, ctx, key);
    };
  }
  if (real.verify || demo?.verify) {
    adapter.verify = async (inputs, output, ctx) => {
      const use = (await linked(ctx)) ? real : (demo ?? real);
      if (!use.verify) return { verified: false, detail: "no verifier" };
      return use.verify(inputs, output, ctx);
    };
  }
  return adapter;
}

export function realAdapterRegistry(config: RealRegistryConfig): Map<string, CapabilityAdapter> {
  const transport = config.transport ?? fetchTransport;
  const idempotency = config.idempotency ?? new MemoryIdempotencyStore();

  // Provider-agnostic steps that touch no connector.
  const registry = pureReconciliationAdapters();

  // The field diff is pure; it reads the matched record carried on each match.
  registry.set("salesforce.propose_field_updates", {
    id: "salesforce.propose_field_updates",
    proposeWrite: async (inputs) =>
      proposeFieldUpdatesFromMatches(inputs["matches"] as MatchResult),
  });

  const sf = salesforceCapabilities({ credentials: config.credentials, transport, idempotency });
  for (const capId of ["salesforce.query_records", "salesforce.update_fields"] as const) {
    registry.set(
      capId,
      withPerOrgFallback(
        "salesforce",
        sf.get(capId)!,
        config.demoFallback.get(capId),
        config.credentials,
      ),
    );
  }

  // Google Sheets: real only (no demo fallback — not part of the demo recipe).
  const sheets = googleSheetsCapabilities({
    credentials: config.credentials,
    transport,
    idempotency,
  });
  for (const [capId, adapter] of sheets) registry.set(capId, adapter);

  return registry;
}
