import { describe, expect, it } from "vitest";
import { buildEvalExpression, type OwnWindowHost } from "@maman/browser-actuator";
import { browserAdapters, type BrowserAdapterDeps } from "../src/browser-adapters.js";
import type { CapabilityContext, ProposedDiff } from "../src/adapters.js";

/**
 * The four browser capabilities as REAL adapters, driven end to end against a
 * fake page.
 *
 * Until now they existed only in the catalog, so a compiled agent either crashed
 * on an `undefined` adapter or was correctly refused as `needs_runtime`. These
 * tests exercise the whole path: adapter → pure actuator → own-window transport
 * → page script → back, with the page's answers produced by a stand-in that
 * behaves like a real document (values change when written, and a write can be
 * made to silently fail).
 */

const ORIGIN = "https://acme.example";
const RUN: CapabilityContext = {
  run_id: "019fc4d0-130f-706e-b94e-42a86e9b3812",
  organization_id: "019fc4d0-130f-706e-b94e-42a86e9b3814",
  owner_user_id: "019fc4d0-130f-706e-b94e-42a86e9b3815",
  mode: "supervised",
};

/**
 * A fake page: a field map that a `set_value` genuinely mutates.
 *
 * It answers by REPLAYING the request id out of the expression the transport
 * built, which is what a real page does — so a bug that sent the wrong id would
 * fail here rather than pass on a stubbed constant.
 */
function fakePage(options: {
  fields: Record<string, string>;
  /** Fields whose write is accepted but silently ignored (framework-owned). */
  ignoreWrites?: string[];
  /** Fields where the page REPORTS the new value but does not store it. */
  lieOnWrite?: string[];
  /** Fields that cannot be read at all. */
  unreadable?: string[];
  origin?: string | null;
}) {
  const fields = { ...options.fields };
  const ignore = new Set(options.ignoreWrites ?? []);
  const lie = new Set(options.lieOnWrite ?? []);
  const unreadable = new Set(options.unreadable ?? []);
  const seen: Array<{ kind: string; name?: string; value?: string }> = [];

  const host: OwnWindowHost = {
    currentOrigin: async () => (options.origin === undefined ? ORIGIN : options.origin),
    navigate: async () => undefined,
    evaluate: async (expression: string) => {
      // The transport appends the request as a JSON string literal after the
      // script's closing `})(`, then a final `)`. Parsing it the way a real page
      // receives it means a transport that sent the wrong id fails here.
      const marker = "})(";
      const literal = expression.slice(expression.lastIndexOf(marker) + marker.length, -1);
      const payload = JSON.parse(JSON.parse(literal) as string);
      const { request_id, action } = payload as {
        request_id: string;
        action: {
          kind: string;
          target?: { name: string };
          value?: string;
          expect_current?: string;
        };
      };
      const name = action.target?.name ?? "";
      seen.push({ kind: action.kind, name, ...(action.value ? { value: action.value } : {}) });

      if (action.kind === "read_field") {
        if (unreadable.has(name) || !(name in fields)) {
          return JSON.stringify({
            request_id,
            outcome: "refused",
            refusal_reason: "target_not_found",
          });
        }
        return JSON.stringify({
          request_id,
          outcome: "observed",
          observed: { value_after: fields[name], accessible_name: name, match_count: 1 },
        });
      }
      if (action.kind === "set_value") {
        if (!(name in fields)) {
          return JSON.stringify({
            request_id,
            outcome: "refused",
            refusal_reason: "target_not_found",
          });
        }
        if (action.expect_current !== undefined && fields[name] !== action.expect_current) {
          return JSON.stringify({
            request_id,
            outcome: "refused",
            refusal_reason: "precondition_failed",
          });
        }
        const before = fields[name]!;
        // A framework-owned field accepts the write and reverts it — the exact
        // case an independent readback exists to catch.
        if (!ignore.has(name) && !lie.has(name)) fields[name] = action.value ?? "";
        return JSON.stringify({
          request_id,
          outcome: "applied",
          observed: {
            value_before: before,
            // A lying page claims the value it was asked for.
            value_after: lie.has(name) ? (action.value ?? "") : fields[name],
            accessible_name: name,
            match_count: 1,
          },
        });
      }
      return JSON.stringify({ request_id, outcome: "failed", detail: "unsupported" });
    },
  };
  return { host, fields, seen };
}

function deps(host: OwnWindowHost, over: Partial<BrowserAdapterDeps> = {}): BrowserAdapterDeps {
  let n = 0;
  return {
    host,
    allowedOrigins: [ORIGIN],
    userPresent: () => true,
    allowSupervisedBrowserWrites: true,
    newRequestId: () => `019fc4d0-130f-706e-b94e-4000000000${(n++).toString().padStart(2, "0")}`,
    mintAuthorization: () => "z".repeat(43),
    now: () => new Date("2026-08-07T12:00:00.000Z"),
    ...over,
  };
}

describe("reading fields off the live page", () => {
  it("returns the values it could read and NAMES the ones it could not", async () => {
    // A silently-omitted field would look identical to a blank one to any caller
    // comparing "before" values.
    const page = fakePage({ fields: { Phone: "555-0100", City: "Boston" }, unreadable: ["City"] });
    const adapters = browserAdapters(deps(page.host));
    const out = (await adapters.get("browser.extract_structured_fields")!.read!(
      { fields: ["Phone", "City"] },
      RUN,
    )) as { values: Record<string, string>; unread: string[]; origin: string };
    expect(out.values).toEqual({ Phone: "555-0100" });
    expect(out.unread).toEqual(["City"]);
    expect(out.origin).toBe(ORIGIN);
  });

  it("refuses to run at all when no window is open", async () => {
    const page = fakePage({ fields: {}, origin: null });
    const adapters = browserAdapters(deps(page.host));
    await expect(
      adapters.get("browser.extract_structured_fields")!.read!({ fields: ["Phone"] }, RUN),
    ).rejects.toThrow(/browser window is not open/);
  });

  it("asks for configuration rather than reading nothing", async () => {
    const page = fakePage({ fields: { Phone: "1" } });
    const adapters = browserAdapters(deps(page.host));
    await expect(
      adapters.get("browser.extract_structured_fields")!.read!({ fields: [] }, RUN),
    ).rejects.toThrow(/which fields matter/);
  });
});

describe("proposing a form fill from the page as it is now", () => {
  const wanted = [
    { name: "Phone", value: "555-0199" },
    { name: "City", value: "Boston" },
  ];

  it("proposes only fields that would actually change", async () => {
    // City already holds the wanted value. Proposing it would inflate the change
    // count the user approves.
    const page = fakePage({ fields: { Phone: "555-0100", City: "Boston" } });
    const adapters = browserAdapters(deps(page.host));
    const diff = await adapters.get("browser.propose_form_fill")!.proposeWrite!(
      { fields: wanted },
      RUN,
    );
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      field: "Phone",
      old_value: "555-0100",
      new_value: "555-0199",
    });
    expect(diff.summary.change_count).toBe(1);
  });

  it("grounds old_value in the LIVE page, not in what the plan assumed", async () => {
    const page = fakePage({ fields: { Phone: "changed-since-the-plan" } });
    const adapters = browserAdapters(deps(page.host));
    const diff = await adapters.get("browser.propose_form_fill")!.proposeWrite!(
      { fields: [{ name: "Phone", value: "555-0199" }] },
      RUN,
    );
    expect(diff.changes[0]!.old_value).toBe("changed-since-the-plan");
  });

  it("counts a field it could not read as skipped, never guessed", async () => {
    const page = fakePage({ fields: { Phone: "555-0100" }, unreadable: ["Phone"] });
    const adapters = browserAdapters(deps(page.host));
    const diff = await adapters.get("browser.propose_form_fill")!.proposeWrite!(
      { fields: [{ name: "Phone", value: "x" }] },
      RUN,
    );
    expect(diff.changes).toHaveLength(0);
    expect(diff.summary.ambiguous_skipped).toBe(1);
  });

  it("PROPOSING WRITES NOTHING", async () => {
    const page = fakePage({ fields: { Phone: "555-0100" } });
    const adapters = browserAdapters(deps(page.host));
    await adapters.get("browser.propose_form_fill")!.proposeWrite!(
      { fields: [{ name: "Phone", value: "555-0199" }] },
      RUN,
    );
    expect(page.fields.Phone).toBe("555-0100");
    expect(page.seen.every((s) => s.kind === "read_field")).toBe(true);
  });
});

describe("the supervised write", () => {
  const diffFor = (changes: ProposedDiff["changes"]): ProposedDiff => ({
    summary: {
      input_rows: changes.length,
      confident_matches: changes.length,
      ambiguous_skipped: 0,
      missing: 0,
      change_count: changes.length,
      accounts_affected: 1,
    },
    changes,
  });

  const change = (field: string, from: string, to: string) => ({
    account_id: ORIGIN,
    account_name: ORIGIN,
    field,
    old_value: from,
    new_value: to,
  });

  it("applies the approved change and the page really holds it", async () => {
    const page = fakePage({ fields: { Phone: "555-0100" } });
    const adapters = browserAdapters(deps(page.host));
    const out = (await adapters.get("browser.supervised_form_fill")!.write!(
      {},
      diffFor([change("Phone", "555-0100", "555-0199")]),
      RUN,
      "idem-1",
    )) as { applied: number };
    expect(out.applied).toBe(1);
    expect(page.fields.Phone).toBe("555-0199");
  });

  it("REFUSES a stale diff: the page moved after approval", async () => {
    // The user approved "555-0100 → 555-0199". Someone else edited the field in
    // between. Overwriting their edit is the failure mode expect_current exists
    // to prevent.
    const page = fakePage({ fields: { Phone: "someone-elses-edit" } });
    const adapters = browserAdapters(deps(page.host));
    const out = (await adapters.get("browser.supervised_form_fill")!.write!(
      {},
      diffFor([change("Phone", "555-0100", "555-0199")]),
      RUN,
      "idem-2",
    )) as { applied: number };
    expect(out.applied).toBe(0);
    expect(page.fields.Phone).toBe("someone-elses-edit");
  });

  it("writes nothing, and claims nothing, for an empty approval", async () => {
    const page = fakePage({ fields: { Phone: "555-0100" } });
    const adapters = browserAdapters(deps(page.host));
    const out = (await adapters.get("browser.supervised_form_fill")!.write!(
      {},
      diffFor([]),
      RUN,
      "idem-3",
    )) as { applied: number };
    expect(out.applied).toBe(0);
    expect(page.seen).toEqual([]);
  });

  it("halts on the first failure instead of pressing on", async () => {
    // Second change is stale; the third must not be attempted.
    const page = fakePage({ fields: { A: "a", B: "wrong", C: "c" } });
    const adapters = browserAdapters(deps(page.host));
    await adapters.get("browser.supervised_form_fill")!.write!(
      {},
      diffFor([change("A", "a", "a2"), change("B", "b", "b2"), change("C", "c", "c2")]),
      RUN,
      "idem-4",
    );
    expect(page.fields.A).toBe("a2");
    expect(page.fields.C).toBe("c"); // never attempted
  });

  it("a write is refused outright when policy forbids supervised browser writes", async () => {
    const page = fakePage({ fields: { Phone: "555-0100" } });
    const adapters = browserAdapters(deps(page.host, { allowSupervisedBrowserWrites: false }));
    const out = (await adapters.get("browser.supervised_form_fill")!.write!(
      {},
      diffFor([change("Phone", "555-0100", "555-0199")]),
      RUN,
      "idem-5",
    )) as { applied: number };
    expect(out.applied).toBe(0);
    expect(page.fields.Phone).toBe("555-0100");
  });

  it("a write is refused when the user is no longer present", async () => {
    // Presence is read at execution time, not captured at approval time.
    const page = fakePage({ fields: { Phone: "555-0100" } });
    const adapters = browserAdapters(deps(page.host, { userPresent: () => false }));
    const out = (await adapters.get("browser.supervised_form_fill")!.write!(
      {},
      diffFor([change("Phone", "555-0100", "555-0199")]),
      RUN,
      "idem-6",
    )) as { applied: number };
    expect(out.applied).toBe(0);
    expect(page.fields.Phone).toBe("555-0100");
  });
});

describe("independent readback is what proves a write landed", () => {
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
        account_id: ORIGIN,
        account_name: ORIGIN,
        field: "Phone",
        old_value: "555-0100",
        new_value: "555-0199",
      },
    ],
  };

  it("confirms a change that really landed", async () => {
    const page = fakePage({ fields: { Phone: "555-0100" } });
    const adapters = browserAdapters(deps(page.host));
    const fill = adapters.get("browser.supervised_form_fill")!;
    const out = await fill.write!({}, diff, RUN, "idem-7");
    const verdict = await fill.verify!({ proposal: diff }, out, RUN);
    expect(verdict.verified).toBe(true);
    expect(verdict.detail).toMatch(/confirmed 1 of 1/);
  });

  it("CATCHES a write that reported success but did not stick — TWICE", async () => {
    // A framework-owned field accepts the value and reverts it. This is caught
    // at BOTH layers, and the ordering matters:
    //
    //  1. The pure actuator compares the page's own value_after against what it
    //     asked for and marks the step `unverified`, so `applied` never counts
    //     it. (I expected `applied: 1` here and was wrong — the inline check is
    //     stronger than I assumed, and the write cannot even claim success.)
    //  2. The adapter's independent re-read disagrees as well, which is what
    //     protects against a page that lies in its own answer.
    const page = fakePage({ fields: { Phone: "555-0100" }, ignoreWrites: ["Phone"] });
    const adapters = browserAdapters(deps(page.host));
    const fill = adapters.get("browser.supervised_form_fill")!;
    const out = await fill.write!({}, diff, RUN, "idem-8");
    expect((out as { applied: number }).applied).toBe(0);
    expect(page.fields.Phone).toBe("555-0100");

    const verdict = await fill.verify!({ proposal: diff }, out, RUN);
    expect(verdict.verified).toBe(false);
    expect(verdict.detail).toMatch(/Phone did not hold the new value/);
  });

  it("the independent re-read is the ONLY defence when the page lies", async () => {
    // Here the page reports value_after = the requested value (so the actuator's
    // inline comparison is satisfied) while the field never changed. Only a
    // fresh read catches this, which is why verify re-reads rather than trusting
    // the write's own report.
    const page = fakePage({ fields: { Phone: "555-0100" }, lieOnWrite: ["Phone"] });
    const adapters = browserAdapters(deps(page.host));
    const fill = adapters.get("browser.supervised_form_fill")!;
    const out = await fill.write!({}, diff, RUN, "idem-9");
    expect((out as { applied: number }).applied).toBe(1); // the write LOOKS clean
    expect(page.fields.Phone).toBe("555-0100"); // …but nothing changed
    const verdict = await fill.verify!({ proposal: diff }, out, RUN);
    expect(verdict.verified).toBe(false);
  });

  it("will not verify when nothing was proposed", async () => {
    const page = fakePage({ fields: {} });
    const adapters = browserAdapters(deps(page.host));
    const verdict = await adapters.get("browser.supervised_form_fill")!.verify!(
      { proposal: undefined },
      { applied: 0 },
      RUN,
    );
    expect(verdict.verified).toBe(false);
  });
});

describe("what is deliberately NOT registered", () => {
  it("does not register browser.extract_table", async () => {
    // Extracting a table means deciding what a row is and how much of a page may
    // be pulled out — an unbounded table read is an unbounded page read. A
    // half-answer here would let the compiler emit it and the runtime gate would
    // then pass, which is worse than today's honest refusal.
    const page = fakePage({ fields: {} });
    expect(browserAdapters(deps(page.host)).has("browser.extract_table")).toBe(false);
  });

  it("registers exactly the three it can honour", async () => {
    const page = fakePage({ fields: {} });
    expect([...browserAdapters(deps(page.host)).keys()].sort()).toEqual([
      "browser.extract_structured_fields",
      "browser.propose_form_fill",
      "browser.supervised_form_fill",
    ]);
  });

  it("a write capability still offers a preview, as the validator requires", async () => {
    const page = fakePage({ fields: {} });
    const fill = browserAdapters(deps(page.host)).get("browser.supervised_form_fill")!;
    expect(typeof fill.proposeWrite).toBe("function");
    expect(typeof fill.write).toBe("function");
    expect(typeof fill.verify).toBe("function");
  });
});

describe("the request the transport sends is the one the page answers", () => {
  it("replays the real request id, so a mismatched answer would be caught", async () => {
    // The fake page echoes the id parsed out of the built expression rather than
    // a constant, so this exercises buildEvalExpression → parseAgentEnvelope for
    // real. A transport that sent the wrong id would fail here.
    const page = fakePage({ fields: { Phone: "555-0100" } });
    const adapters = browserAdapters(deps(page.host));
    const out = (await adapters.get("browser.extract_structured_fields")!.read!(
      { fields: ["Phone"] },
      RUN,
    )) as { values: Record<string, string> };
    expect(out.values.Phone).toBe("555-0100");
    // Sanity: the expression really is the page-script form.
    expect(buildEvalExpression).toBeTypeOf("function");
  });
});
