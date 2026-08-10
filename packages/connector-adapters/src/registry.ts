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
 * locally; provider capabilities use live connectors.
 *
 * THE FALLBACK IS ASYMMETRIC, AND THAT IS THE DESIGN.
 *
 * Per capability, per org: when no connector is linked, a Salesforce READ falls
 * back to the deterministic demo adapter, so an org that has not connected
 * anything yet can still see the shape of a run. That substitution is reported
 * through `onDemoFallback` rather than hidden, because fixture output presented
 * as the org's own records is a lie the caller would otherwise tell.
 *
 * A WRITE never falls back. It used to — `demo ?? real` applied to every method
 * — which meant an unlinked org's supervised write mutated an in-memory demo
 * world, returned success, and produced a run reporting records updated in a
 * Salesforce that was never contacted. Nothing downstream could detect it,
 * because the write genuinely succeeded; it just succeeded somewhere else.
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
  /**
   * Called whenever demo data served a READ because no connector was linked.
   *
   * The fallback is a real affordance — a run is not blocked just because an
   * org has not connected Salesforce yet — but its output is fixture data, and
   * a caller that cannot tell will present it as the org's own records. This is
   * how the caller finds out, so a receipt or a panel can say so.
   */
  onDemoFallback?: (info: {
    capability_id: string;
    provider: string;
    organization_id: string;
  }) => void;
};

/**
 * Thrown when a WRITE is attempted against a provider the org has not linked.
 *
 * Reads may fall back to demo data; writes may not, and the asymmetry is the
 * point. A read served from fixtures produces a number that is wrong. A write
 * served from fixtures mutates an in-memory demo world, returns success, and
 * the run reports "updated 4 records in Salesforce" — to a user whose
 * Salesforce was never touched, who now believes their records are current.
 * There is no honest way to report that afterwards, so it must not happen.
 */
export class ConnectorNotLinkedError extends Error {
  readonly provider: string;
  readonly capability_id: string;

  constructor(provider: string, capabilityId: string) {
    super(
      `This run needs to write to ${provider}, but no ${provider} connection is linked for your organization. Connect ${provider} and run it again — I will not write to demo data and call it done.`,
    );
    this.name = "ConnectorNotLinkedError";
    this.provider = provider;
    this.capability_id = capabilityId;
  }
}

/** Delegates each method to the real adapter when the org has the connector linked, else demo. */
function withPerOrgFallback(
  provider: string,
  real: CapabilityAdapter,
  demo: CapabilityAdapter | undefined,
  credentials: CredentialProvider,
  onDemoFallback?: RealRegistryConfig["onDemoFallback"],
): CapabilityAdapter {
  const linked = (ctx: CapabilityContext) =>
    credentials.load({ organization_id: ctx.organization_id, provider }).then((c) => c !== null);

  /** Reports the substitution before returning the demo adapter. */
  const fellBack = (ctx: CapabilityContext): CapabilityAdapter | undefined => {
    onDemoFallback?.({
      capability_id: real.id,
      provider,
      organization_id: ctx.organization_id,
    });
    return demo;
  };

  const adapter: CapabilityAdapter = { id: real.id };
  if (real.read || demo?.read) {
    adapter.read = async (inputs, ctx) => {
      const use = (await linked(ctx)) ? real : (fellBack(ctx) ?? real);
      if (!use.read) throw new Error(`${real.id}: no read implementation`);
      return use.read(inputs, ctx);
    };
  }
  if (real.proposeWrite || demo?.proposeWrite) {
    adapter.proposeWrite = async (inputs, ctx) => {
      // A proposal built from demo data shows the user a diff of FIXTURE
      // records. Reported for the same reason a read is: the diff is what they
      // are asked to approve, and they cannot consent to it meaningfully while
      // believing it describes their own data.
      const use = (await linked(ctx)) ? real : (fellBack(ctx) ?? real);
      if (!use.proposeWrite) throw new Error(`${real.id}: no proposeWrite implementation`);
      return use.proposeWrite(inputs, ctx);
    };
  }
  if (real.write) {
    adapter.write = async (inputs, diff, ctx, key) => {
      // NO FALLBACK. See `ConnectorNotLinkedError`: a demo write returns
      // success for a system it never touched, and the run then reports records
      // as updated. Refusing is the only outcome that stays true.
      if (!(await linked(ctx))) throw new ConnectorNotLinkedError(provider, real.id);
      if (!real.write) throw new Error(`${real.id}: no write implementation`);
      return real.write(inputs, diff, ctx, key);
    };
  }
  if (real.verify || demo?.verify) {
    adapter.verify = async (inputs, output, ctx) => {
      // Verification follows the write: if the write was refused there is
      // nothing here to verify, and a demo verifier confirming a demo write
      // would be two fictions agreeing with each other.
      const use = (await linked(ctx)) ? real : (fellBack(ctx) ?? real);
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
        config.onDemoFallback,
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
