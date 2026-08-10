import {
  COMPARED_FIELDS,
  DEMO_CSV_ROWS,
  DEMO_SF_ACCOUNTS,
  type CsvAccountRow,
  isSfWritableField,
  type ProposedFieldChange,
  type SfAccount,
} from "@maman/demo-fixtures";

/**
 * Capability adapters (spec §15). The demo implementations are deterministic,
 * support configurable latency and fault injection, record request assertions,
 * and honor idempotency keys — the full product loop runs on these with zero
 * credentials. Real connector adapters implement the same interface at M8.
 */

export type AdapterFaults = {
  /** Fail the next N calls with a transient (retry-safe) error. */
  transient_failures?: number;
  /** Every call fails permanently. */
  permanent_failure?: boolean;
  /** Simulate provider rate limiting (retry-safe, surfaced as such). */
  rate_limited?: boolean;
  latency_ms?: number;
};

export class TransientAdapterError extends Error {
  readonly retry_safe = true;
}
export class PermanentAdapterError extends Error {
  readonly retry_safe = false;
}

export type CapabilityContext = {
  run_id: string;
  organization_id: string;
  owner_user_id: string;
  mode: "shadow" | "supervised" | "active";
};

export type ProposedDiff = {
  summary: {
    input_rows: number;
    confident_matches: number;
    ambiguous_skipped: number;
    missing: number;
    change_count: number;
    accounts_affected: number;
  };
  changes: ProposedFieldChange[];
};

/**
 * Synchronous FNV-1a-based 256-bit digest of the canonical diff JSON. Runs in
 * both Node and the browser/webview (no node:crypto) — used only for approval
 * diff binding where a stable, collision-resistant-enough fingerprint suffices
 * (approval is additionally step- and run-bound). The server mints and hashes
 * the one-time approval TOKEN with a real SHA-256 in the Node-only worker.
 */
export function diffSha256(diff: unknown): string {
  const input = JSON.stringify(diff);
  // Eight independently-seeded 32-bit FNV-1a lanes → 64 hex chars.
  const seeds = [
    0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xdeadbeef,
  ];
  return seeds
    .map((seed) => {
      let h = seed >>> 0;
      for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

export type CapabilityAdapter = {
  id: string;
  read?: (inputs: Record<string, unknown>, ctx: CapabilityContext) => Promise<unknown>;
  proposeWrite?: (inputs: Record<string, unknown>, ctx: CapabilityContext) => Promise<ProposedDiff>;
  write?: (
    inputs: Record<string, unknown>,
    approvedDiff: ProposedDiff,
    ctx: CapabilityContext,
    idempotencyKey: string,
  ) => Promise<unknown>;
  verify?: (
    inputs: Record<string, unknown>,
    output: unknown,
    ctx: CapabilityContext,
  ) => Promise<{ verified: boolean; detail: string }>;
};

/** Stateful demo Salesforce org: mutations persist for verification reads. */
export class DemoSalesforceWorld {
  accounts: SfAccount[];
  /** idempotency ledger: key → result of the (single) applied write */
  applied = new Map<string, unknown>();
  requests: Array<{ capability: string; at: number }> = [];
  faults: AdapterFaults = {};

  constructor(accounts: SfAccount[] = structuredClone(DEMO_SF_ACCOUNTS)) {
    this.accounts = accounts;
  }

  async guard(capability: string): Promise<void> {
    this.requests.push({ capability, at: this.requests.length });
    if (this.faults.latency_ms) {
      await new Promise((resolve) => setTimeout(resolve, this.faults.latency_ms));
    }
    if (this.faults.permanent_failure) {
      throw new PermanentAdapterError(`${capability}: permanent provider failure (demo)`);
    }
    if (this.faults.rate_limited) {
      throw new TransientAdapterError(`${capability}: rate limited (demo)`);
    }
    if ((this.faults.transient_failures ?? 0) > 0) {
      this.faults.transient_failures = (this.faults.transient_failures ?? 0) - 1;
      throw new TransientAdapterError(`${capability}: transient provider failure (demo)`);
    }
  }
}

export type MatchResult = {
  matches: Array<{ row: CsvAccountRow; account_id: string; account: SfAccount }>;
  ambiguous: CsvAccountRow[];
  missing: CsvAccountRow[];
};

export function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
}

/**
 * Pure field-diff for the reconciliation recipe. Each matched entry carries the
 * current Salesforce record, so this is provider-agnostic (no live world / no
 * extra query): both the demo world and the real Salesforce adapter feed it the
 * matched account and the desired row.
 */
export function proposeFieldUpdatesFromMatches(match: MatchResult): ProposedDiff {
  const changes: ProposedFieldChange[] = [];
  for (const { row, account_id, account } of match.matches) {
    for (const field of COMPARED_FIELDS) {
      const oldValue = String(account[field]);
      const newValue = String(row[field === "employee_count" ? "employee_count" : field]);
      if (oldValue !== newValue) {
        changes.push({
          account_id,
          account_name: account.name,
          field,
          old_value: oldValue,
          new_value: newValue,
        });
      }
    }
  }
  return {
    summary: {
      input_rows: match.matches.length + match.ambiguous.length + match.missing.length,
      confident_matches: match.matches.length,
      ambiguous_skipped: match.ambiguous.length,
      missing: match.missing.length,
      change_count: changes.length,
      accounts_affected: new Set(changes.map((c) => c.account_id)).size,
    },
    changes,
  };
}

/** Deterministic domain-keyed matching, provider-agnostic. */
export function matchAccounts(rows: CsvAccountRow[], accounts: SfAccount[]): MatchResult {
  const result: MatchResult = { matches: [], ambiguous: [], missing: [] };
  for (const row of rows) {
    const domain = normalizeDomain(row.domain);
    const candidates = accounts.filter((a) => normalizeDomain(a.domain) === domain);
    if (candidates.length === 0) {
      result.missing.push(row);
    } else if (candidates.length > 1) {
      result.ambiguous.push(row); // duplicate accounts → never guess
    } else if (candidates[0]!.name !== row.company) {
      result.ambiguous.push(row); // name mismatch → never guess
    } else {
      result.matches.push({ row, account_id: candidates[0]!.id, account: candidates[0]! });
    }
  }
  return result;
}

/**
 * Provider-agnostic reconciliation steps that touch no live connector: CSV
 * parse/transform, domain matching, the field diff, and the report. Both the
 * demo registry and the real connector registry compose these; only
 * query_records / update_fields differ by provider.
 */
/**
 * The value `account_csv` must hold for the bundled sample list to be used.
 *
 * A sentinel rather than a default, so choosing demo data is something a caller
 * DID, recorded in the run's inputs and visible on the receipt — not something
 * that happened because nobody supplied anything.
 */
export const DEMO_ACCOUNT_LIST = "demo:bundled-account-list";

export function pureReconciliationAdapters(): Map<string, CapabilityAdapter> {
  const registry = new Map<string, CapabilityAdapter>();

  registry.set("local.parse_csv", {
    id: "local.parse_csv",
    /**
     * Serves the bundled sample list, and ONLY when it was explicitly asked for.
     *
     * This used to be `read: async () => structuredClone(DEMO_CSV_ROWS)` — no
     * parameters at all. Whatever the spec bound to `account_csv` was ignored,
     * including nothing: the reconciliation spec declares that input required,
     * the desktop supplied none, and the run reconciled FIXTURE ROWS end to
     * end, produced a diff, and published a receipt with ROI for an account
     * list the user never gave it.
     *
     * Reading the value fixes both halves. An unbound input can no longer reach
     * demo data, and a REAL file path is refused rather than silently answered
     * with fixtures — this adapter cannot read a file, and pretending otherwise
     * is how demo output gets mistaken for a result.
     */
    read: async (inputs) => {
      const file = inputs["file"];
      if (file !== DEMO_ACCOUNT_LIST) {
        throw new PermanentAdapterError(
          typeof file === "string" && file.length > 0
            ? `This demo runtime cannot read "${file}". It only has the bundled sample list.`
            : "No account list was provided, and this demo runtime will not invent one.",
        );
      }
      return structuredClone(DEMO_CSV_ROWS);
    },
  });

  registry.set("local.transform_columns", {
    id: "local.transform_columns",
    read: async (inputs) => {
      const rows = (inputs["rows"] as CsvAccountRow[]) ?? [];
      return rows.map((row) => ({ ...row, domain: normalizeDomain(row.domain) }));
    },
  });

  registry.set("local.match_records", {
    id: "local.match_records",
    read: async (inputs) =>
      matchAccounts(
        (inputs["left"] as CsvAccountRow[]) ?? [],
        (inputs["right"] as SfAccount[]) ?? [],
      ),
  });

  registry.set("local.generate_csv", {
    id: "local.generate_csv",
    read: async (inputs) => {
      const updates = inputs["updates"] as { applied?: number } | undefined;
      const match = inputs["matches"] as MatchResult | undefined;
      return {
        report: "reconciliation.csv",
        rows:
          (match?.matches.length ?? 0) +
          (match?.ambiguous.length ?? 0) +
          (match?.missing.length ?? 0),
        applied_changes: updates?.applied ?? 0,
      };
    },
  });

  return registry;
}

export function demoAdapterRegistry(world: DemoSalesforceWorld): Map<string, CapabilityAdapter> {
  const registry = pureReconciliationAdapters();

  // NO BROWSER ADAPTERS HERE, deliberately.
  //
  // This registry used to serve `browser.extract_table` and
  // `browser.extract_structured_fields` with DEMO_CSV_ROWS — Salesforce CSV
  // fixtures returned as "the fields I read off the page". A browser workflow's
  // read step was therefore answered with invented data that the user would see
  // as a real observation of their own page.
  //
  // The stated reason was "so a read-only agent can complete a run instead of
  // dying on a missing adapter". That is obsolete: `validateRuntimeCapabilities`
  // and `requireAdapter` now refuse a spec whose capabilities are unavailable,
  // with a message naming what is missing. An honest refusal beats a completed
  // run built on fixtures.
  //
  // Real browser capabilities come from `browserAdapters()`, which needs a
  // transport and the user's origin allowlist.

  registry.set("salesforce.query_records", {
    id: "salesforce.query_records",
    read: async (inputs) => {
      await world.guard("salesforce.query_records");
      const rows = (inputs["keys"] as CsvAccountRow[]) ?? [];
      const domains = new Set(rows.map((r) => normalizeDomain(r.domain)));
      return world.accounts.filter((a) => domains.has(normalizeDomain(a.domain)));
    },
  });

  registry.set("salesforce.propose_field_updates", {
    id: "salesforce.propose_field_updates",
    proposeWrite: async (inputs) => {
      await world.guard("salesforce.propose_field_updates");
      return proposeFieldUpdatesFromMatches(inputs["matches"] as MatchResult);
    },
  });

  registry.set("salesforce.update_fields", {
    id: "salesforce.update_fields",
    write: async (_inputs, approvedDiff, _ctx, idempotencyKey) => {
      await world.guard("salesforce.update_fields");
      // Idempotency: the fake Salesforce accepts each key exactly once.
      if (world.applied.has(idempotencyKey)) {
        return world.applied.get(idempotencyKey);
      }
      let appliedCount = 0;
      for (const change of approvedDiff.changes) {
        const account = world.accounts.find((a) => a.id === change.account_id);
        if (!account) continue;
        // EXPLICIT: only fields this adapter owns may be written. Previously the
        // union type was the only thing stopping an arbitrary key being set on
        // the account object; now a diff naming a field Salesforce does not have
        // (e.g. a browser control's accessible name) is skipped rather than
        // silently creating a property.
        if (!isSfWritableField(change.field)) continue;
        if (change.field === "employee_count") {
          account.employee_count = Number(change.new_value);
        } else {
          account[change.field] = change.new_value;
        }
        appliedCount++;
      }
      const result = { applied: appliedCount, idempotency_key: idempotencyKey };
      world.applied.set(idempotencyKey, result);
      return result;
    },
    verify: async (inputs, output) => {
      await world.guard("salesforce.update_fields.verify");
      // Independent read: re-fetch each account and confirm the new values.
      const proposal = inputs["proposal"] as ProposedDiff | undefined;
      const changes = proposal?.changes ?? [];
      let confirmed = 0;
      for (const change of changes) {
        if (!isSfWritableField(change.field)) continue;
        const account = world.accounts.find((a) => a.id === change.account_id);
        if (account && String(account[change.field]) === change.new_value) confirmed++;
      }
      const applied = (output as { applied?: number }).applied ?? 0;
      const verified = confirmed === changes.length && applied === changes.length;
      return {
        verified,
        detail: `independent read confirmed ${confirmed}/${changes.length} field change(s)`,
      };
    },
  });

  return registry;
}
