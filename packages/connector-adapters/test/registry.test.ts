import { describe, expect, it } from "vitest";
import {
  DemoSalesforceWorld,
  demoAdapterRegistry,
  type CapabilityContext,
  type ProposedDiff,
} from "@maman/agent-runtime";
import {
  ConnectorNotLinkedError,
  MemoryIdempotencyStore,
  realAdapterRegistry,
  type CredentialProvider,
  type HttpRequest,
  type HttpResponse,
} from "../src/index.js";

const ctx: CapabilityContext = {
  run_id: "r",
  organization_id: "org-1",
  owner_user_id: "u",
  mode: "supervised",
};

function transport(handler: (req: HttpRequest) => HttpResponse) {
  const calls: HttpRequest[] = [];
  return {
    calls,
    transport: async (req: HttpRequest) => {
      calls.push(req);
      return handler(req);
    },
  };
}

describe("realAdapterRegistry — per-org fallback", () => {
  it("uses the demo adapter when no Salesforce connector is linked (no network)", async () => {
    const notLinked: CredentialProvider = {
      load: async () => null,
      refresh: async () => ({ access_token: "" }),
    };
    const t = transport(() => ({ status: 200, headers: {}, body: {} }));
    const registry = realAdapterRegistry({
      credentials: notLinked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    const rows = (await registry.get("salesforce.query_records")!.read!(
      { keys: [{ domain: "northwind.example" }] },
      ctx,
    )) as unknown[];
    // Demo world answered; the real HTTP transport was never called.
    expect(t.calls.length).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("uses the real adapter when the org has a linked connector", async () => {
    const linked: CredentialProvider = {
      load: async () => ({ access_token: "tok", instance_url: "https://na1.example.com" }),
      refresh: async () => ({ access_token: "tok", instance_url: "https://na1.example.com" }),
    };
    const t = transport(() => ({
      status: 200,
      headers: {},
      body: {
        records: [
          {
            Id: "001A",
            Name: "Northwind Traders",
            Website: "https://northwind.example",
            NumberOfEmployees: 250,
            Account_Owner_Name__c: "Alex",
            Market_Segment__c: "Mid-Market",
          },
        ],
      },
    }));
    const registry = realAdapterRegistry({
      credentials: linked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    await registry.get("salesforce.query_records")!.read!(
      { keys: [{ domain: "northwind.example" }] },
      ctx,
    );
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]!.headers["authorization"]).toBe("Bearer tok");
  });

  it("keeps the pure steps (parse/transform/match/propose) provider-independent", async () => {
    const notLinked: CredentialProvider = {
      load: async () => null,
      refresh: async () => ({ access_token: "" }),
    };
    const registry = realAdapterRegistry({
      credentials: notLinked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
    });
    expect(registry.has("local.parse_csv")).toBe(true);
    expect(registry.has("local.match_records")).toBe(true);
    // propose is pure — works with a matches input carrying the account record.
    const proposal = (await registry.get("salesforce.propose_field_updates")!.proposeWrite!(
      {
        matches: {
          matches: [
            {
              row: {
                company: "N",
                domain: "n.example",
                owner: "Alex",
                employee_count: 250,
                website: "https://n.example",
                segment: "SMB",
              },
              account_id: "001A",
              account: {
                id: "001A",
                name: "N",
                domain: "n.example",
                owner: "Jordan",
                employee_count: 250,
                website: "https://n.example",
                segment: "SMB",
              },
            },
          ],
          ambiguous: [],
          missing: [],
        },
      },
      ctx,
    )) as ProposedDiff;
    expect(proposal.summary.change_count).toBe(1); // owner Jordan -> Alex
    expect(proposal.changes[0]!.field).toBe("owner");
  });
});

describe("realAdapterRegistry — multi-provider (Google Sheets)", () => {
  it("reads a range and writes cells over the real transport", async () => {
    const linked: CredentialProvider = {
      load: async () => ({ access_token: "gtok" }),
      refresh: async () => ({ access_token: "gtok2" }),
    };
    const t = transport((req) =>
      req.method === "GET"
        ? { status: 200, headers: {}, body: { values: [["a", "b"]] } }
        : { status: 200, headers: {}, body: { updatedCells: 2 } },
    );
    const registry = realAdapterRegistry({
      credentials: linked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    const read = (await registry.get("google_sheets.read_range")!.read!(
      { spreadsheet_id: "sheet1", range: "A1:B1" },
      ctx,
    )) as unknown[][];
    expect(read).toEqual([["a", "b"]]);
    expect(t.calls[0]!.headers["authorization"]).toBe("Bearer gtok");
    expect(t.calls[0]!.url).toContain("/spreadsheets/sheet1/values/A1%3AB1");

    const wrote = (await registry.get("google_sheets.write_range")!.write!(
      { spreadsheet_id: "sheet1", range: "A1:B1", values: [["x", "y"]] },
      { summary: {} as ProposedDiff["summary"], changes: [] },
      ctx,
      "gs-idem-1",
    )) as { applied: number };
    expect(wrote.applied).toBe(2);
    expect(t.calls[1]!.method).toBe("PUT");
    expect(t.calls[1]!.url).toContain("valueInputOption=RAW");
  });
});

/**
 * THE ASYMMETRY. Reads may fall back to demo data; writes may not.
 *
 * Every method used to resolve with `demo ?? real`, so an org with no linked
 * connector performed its supervised write against an in-memory demo world.
 * The write genuinely succeeded — somewhere else — and the run reported records
 * updated in a Salesforce it had never contacted. Nothing downstream could
 * detect that, which is why it has to be refused at the point of the write.
 */
describe("realAdapterRegistry — a write is never served by demo data", () => {
  const notLinked: CredentialProvider = {
    load: async () => null,
    refresh: async () => ({ access_token: "" }),
  };
  const linked: CredentialProvider = {
    load: async () => ({ access_token: "tok", instance_url: "https://na1.example.com" }),
    refresh: async () => ({ access_token: "tok", instance_url: "https://na1.example.com" }),
  };

  const diff: ProposedDiff = {
    summary: {
      input_rows: 1,
      confident_matches: 1,
      ambiguous_skipped: 0,
      missing: 0,
      change_count: 1,
      accounts_affected: 1,
    },
    changes: [
      {
        account_id: "001A",
        account_name: "Northwind",
        field: "owner",
        old_value: "Jordan",
        new_value: "Alex",
      },
    ],
  };

  it("REFUSES the write when the org has no connector, instead of writing to demo", async () => {
    const world = new DemoSalesforceWorld();
    const t = transport(() => ({ status: 200, headers: {}, body: {} }));
    const registry = realAdapterRegistry({
      credentials: notLinked,
      demoFallback: demoAdapterRegistry(world),
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });

    await expect(
      registry.get("salesforce.update_fields")!.write!({}, diff, ctx, "key-1"),
    ).rejects.toThrow(ConnectorNotLinkedError);

    // Nothing was contacted, and nothing was mutated anywhere. The second half
    // is the one that matters: before this, the demo world DID change.
    expect(t.calls.length).toBe(0);
    const account = world.accounts.find((a) => a.id === "001A");
    if (account) expect(account.owner).not.toBe("Alex");
  });

  it("names the provider and what to do about it", async () => {
    const registry = realAdapterRegistry({
      credentials: notLinked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
    });
    const error: unknown = await registry.get("salesforce.update_fields")!.write!(
      {},
      diff,
      ctx,
      "key-1",
    )
      .then(() => null)
      .catch((e: unknown) => e);
    if (!(error instanceof ConnectorNotLinkedError)) {
      throw new Error("expected the write to be refused");
    }
    expect(error.provider).toBe("salesforce");
    expect(error.message).toContain("Connect salesforce");
    // The refusal says what it will NOT do, because that is the reassurance.
    expect(error.message).toContain("will not write to demo data");
  });

  it("still writes normally once the connector IS linked", async () => {
    const t = transport(() => ({ status: 200, headers: {}, body: { id: "001A", success: true } }));
    const registry = realAdapterRegistry({
      credentials: linked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    await registry.get("salesforce.update_fields")!.write!({}, diff, ctx, "key-1");
    expect(t.calls.length).toBeGreaterThan(0);
  });

  it("REPORTS a read that demo data served, rather than passing it off silently", async () => {
    // The fallback is legitimate; presenting fixture rows as the org's own
    // records is not. The caller has to be able to say which it got.
    const seen: Array<{ capability_id: string; provider: string; organization_id: string }> = [];
    const registry = realAdapterRegistry({
      credentials: notLinked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
      onDemoFallback: (info) => seen.push(info),
    });
    await registry.get("salesforce.query_records")!.read!(
      { keys: [{ domain: "northwind.example" }] },
      ctx,
    );
    expect(seen).toEqual([
      {
        capability_id: "salesforce.query_records",
        provider: "salesforce",
        organization_id: "org-1",
      },
    ]);
  });

  it("says nothing when the connector is linked — there is nothing to report", async () => {
    const seen: unknown[] = [];
    const t = transport(() => ({ status: 200, headers: {}, body: { records: [] } }));
    const registry = realAdapterRegistry({
      credentials: linked,
      demoFallback: demoAdapterRegistry(new DemoSalesforceWorld()),
      transport: t.transport,
      onDemoFallback: (info) => seen.push(info),
    });
    await registry.get("salesforce.query_records")!.read!(
      { keys: [{ domain: "northwind.example" }] },
      ctx,
    );
    expect(seen).toEqual([]);
  });
});
