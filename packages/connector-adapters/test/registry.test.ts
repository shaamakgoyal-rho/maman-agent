import { describe, expect, it } from "vitest";
import {
  DemoSalesforceWorld,
  demoAdapterRegistry,
  type CapabilityContext,
  type ProposedDiff,
} from "@maman/agent-runtime";
import {
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
