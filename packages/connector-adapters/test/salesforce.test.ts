import { describe, expect, it, vi } from "vitest";
import {
  PermanentAdapterError,
  TransientAdapterError,
  type CapabilityContext,
  type ProposedDiff,
} from "@maman/agent-runtime";
import {
  MemoryIdempotencyStore,
  salesforceCapabilities,
  type CredentialProvider,
  type HttpRequest,
  type HttpResponse,
  type ProviderCredentials,
} from "../src/index.js";

const ctx: CapabilityContext = {
  run_id: "run-1",
  organization_id: "org-1",
  owner_user_id: "user-1",
  mode: "supervised",
};

function mockCredentials(initial: ProviderCredentials, refreshed?: ProviderCredentials) {
  let current = initial;
  const refresh = vi.fn(async () => {
    if (!refreshed) throw new PermanentAdapterError("no refresh");
    current = refreshed;
    return current;
  });
  const provider: CredentialProvider = {
    load: async () => current,
    refresh,
  };
  return { provider, refresh, get: () => current };
}

/** Records requests and replies from a scripted handler. */
function recordingTransport(handler: (req: HttpRequest, n: number) => HttpResponse) {
  const calls: HttpRequest[] = [];
  return {
    calls,
    transport: async (req: HttpRequest): Promise<HttpResponse> => {
      const res = handler(req, calls.length);
      calls.push(req);
      return res;
    },
  };
}

const sfRecord = (over: Record<string, unknown> = {}) => ({
  Id: "001A",
  Name: "Northwind Traders",
  Website: "https://northwind.example",
  NumberOfEmployees: 250,
  Account_Owner_Name__c: "Alex",
  Market_Segment__c: "Mid-Market",
  ...over,
});

describe("SalesforceAdapter — reads", () => {
  it("injects the Bearer token, builds SOQL, and maps records to the demo model", async () => {
    const creds = mockCredentials({
      access_token: "tok1",
      instance_url: "https://na1.example.com",
    });
    const t = recordingTransport(() => ({
      status: 200,
      headers: {},
      body: { records: [sfRecord()] },
    }));
    const sf = salesforceCapabilities({
      credentials: creds.provider,
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    const out = (await sf.get("salesforce.query_records")!.read!(
      { keys: [{ domain: "northwind.example" }] },
      ctx,
    )) as Array<Record<string, unknown>>;

    expect(t.calls[0]!.headers["authorization"]).toBe("Bearer tok1");
    expect(t.calls[0]!.url).toContain("/services/data/v60.0/query");
    expect(decodeURIComponent(t.calls[0]!.url)).toContain("Website LIKE '%northwind.example%'");
    expect(out[0]).toMatchObject({
      id: "001A",
      name: "Northwind Traders",
      domain: "northwind.example",
      owner: "Alex",
      employee_count: 250,
      segment: "Mid-Market",
    });
  });

  it("refreshes the token once on 401 and retries with the new token", async () => {
    const creds = mockCredentials(
      { access_token: "stale", instance_url: "https://na1.example.com" },
      { access_token: "fresh", instance_url: "https://na1.example.com" },
    );
    const t = recordingTransport((_req, n) =>
      n === 0
        ? {
            status: 401,
            headers: {},
            body: [{ errorCode: "INVALID_SESSION_ID", message: "expired" }],
          }
        : { status: 200, headers: {}, body: { records: [sfRecord()] } },
    );
    const sf = salesforceCapabilities({
      credentials: creds.provider,
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    await sf.get("salesforce.query_records")!.read!(
      { keys: [{ domain: "northwind.example" }] },
      ctx,
    );
    expect(creds.refresh).toHaveBeenCalledOnce();
    expect(t.calls[0]!.headers["authorization"]).toBe("Bearer stale");
    expect(t.calls[1]!.headers["authorization"]).toBe("Bearer fresh");
  });

  it("classifies faults: 429/5xx transient, 4xx permanent", async () => {
    const creds = mockCredentials({ access_token: "t", instance_url: "https://x.example.com" });
    for (const [status, kind] of [
      [429, "transient"],
      [503, "transient"],
      [403, "permanent"],
      [400, "permanent"],
    ] as const) {
      const t = recordingTransport(() => ({ status, headers: {}, body: [{ message: "x" }] }));
      const sf = salesforceCapabilities({
        credentials: creds.provider,
        transport: t.transport,
        idempotency: new MemoryIdempotencyStore(),
      });
      const call = sf.get("salesforce.query_records")!.read!(
        { keys: [{ domain: "a.example" }] },
        ctx,
      );
      await expect(call).rejects.toBeInstanceOf(
        kind === "transient" ? TransientAdapterError : PermanentAdapterError,
      );
    }
  });

  it("a network error is transient (retry-safe)", async () => {
    const creds = mockCredentials({ access_token: "t", instance_url: "https://x.example.com" });
    const sf = salesforceCapabilities({
      credentials: creds.provider,
      transport: async () => {
        throw new Error("ECONNRESET");
      },
      idempotency: new MemoryIdempotencyStore(),
    });
    await expect(
      sf.get("salesforce.query_records")!.read!({ keys: [{ domain: "a.example" }] }, ctx),
    ).rejects.toBeInstanceOf(TransientAdapterError);
  });

  it("refuses when no connector is linked", async () => {
    const provider: CredentialProvider = {
      load: async () => null,
      refresh: async () => ({ access_token: "" }),
    };
    const t = recordingTransport(() => ({ status: 200, headers: {}, body: {} }));
    const sf = salesforceCapabilities({
      credentials: provider,
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    await expect(
      sf.get("salesforce.query_records")!.read!({ keys: [{ domain: "a.example" }] }, ctx),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    expect(t.calls.length).toBe(0);
  });
});

const diff: ProposedDiff = {
  summary: {
    input_rows: 1,
    confident_matches: 1,
    ambiguous_skipped: 0,
    missing: 0,
    change_count: 2,
    accounts_affected: 1,
  },
  changes: [
    {
      account_id: "001A",
      account_name: "Northwind Traders",
      field: "owner",
      old_value: "Jordan",
      new_value: "Alex",
    },
    {
      account_id: "001A",
      account_name: "Northwind Traders",
      field: "employee_count",
      old_value: "180",
      new_value: "250",
    },
  ],
};

describe("SalesforceAdapter — writes", () => {
  it("PATCHes one record per account with mapped fields, then is idempotent", async () => {
    const creds = mockCredentials({ access_token: "tok", instance_url: "https://na1.example.com" });
    const t = recordingTransport(() => ({ status: 204, headers: {}, body: "" }));
    const sf = salesforceCapabilities({
      credentials: creds.provider,
      transport: t.transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    const write = sf.get("salesforce.update_fields")!.write!;
    const first = (await write({}, diff, ctx, "idem-1")) as { applied: number };
    expect(first.applied).toBe(2);
    const patches = t.calls.filter((c) => c.method === "PATCH");
    expect(patches.length).toBe(1); // one account → one PATCH
    expect(patches[0]!.url).toContain("/sobjects/Account/001A");
    const body = JSON.parse(patches[0]!.body!) as Record<string, unknown>;
    expect(body["Account_Owner_Name__c"]).toBe("Alex");
    expect(body["NumberOfEmployees"]).toBe(250); // numeric, not "250"

    // Same idempotency key → no second PATCH, prior result returned.
    const again = (await write({}, diff, ctx, "idem-1")) as { applied: number };
    expect(again.applied).toBe(2);
    expect(t.calls.filter((c) => c.method === "PATCH").length).toBe(1);
  });

  it("verification passes only when the independent read-back matches the approved diff", async () => {
    const creds = mockCredentials({ access_token: "tok", instance_url: "https://na1.example.com" });
    // Read-back returns the applied values → verified true.
    const ok = salesforceCapabilities({
      credentials: creds.provider,
      transport: recordingTransport(() => ({
        status: 200,
        headers: {},
        body: { records: [sfRecord({ Account_Owner_Name__c: "Alex", NumberOfEmployees: 250 })] },
      })).transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    const vOk = await ok.get("salesforce.update_fields")!.verify!(
      { proposal: diff },
      { applied: 2 },
      ctx,
    );
    expect(vOk.verified).toBe(true);

    // Read-back shows a stale value → verified false.
    const bad = salesforceCapabilities({
      credentials: creds.provider,
      transport: recordingTransport(() => ({
        status: 200,
        headers: {},
        body: { records: [sfRecord({ Account_Owner_Name__c: "Jordan", NumberOfEmployees: 180 })] },
      })).transport,
      idempotency: new MemoryIdempotencyStore(),
    });
    const vBad = await bad.get("salesforce.update_fields")!.verify!(
      { proposal: diff },
      { applied: 2 },
      ctx,
    );
    expect(vBad.verified).toBe(false);
  });
});
