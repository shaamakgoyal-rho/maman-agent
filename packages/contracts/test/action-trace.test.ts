import { describe, expect, it } from "vitest";
import {
  containsForbiddenEventField,
  containsForbiddenTraceField,
  localActionTrace,
  parseLocalActionTrace,
  traceReadiness,
  uuidv7,
  type LocalActionTrace,
} from "../src/index.js";

/**
 * THE TRACE LAYER MUST BE REPLAYABLE AND STILL SAFE.
 *
 * Two properties are in tension: the trace has to keep enough to reproduce work
 * (which the lossy mining projection deliberately destroys), and it must never
 * keep what was typed or whose data it was. These tests pin both, and pin the
 * structural reasons they cannot drift — a raw value has nowhere to live, and a
 * trace cannot be shaped into a sync payload.
 */

const DIGEST = "a".repeat(64);

function trace(overrides: Partial<LocalActionTrace> = {}): LocalActionTrace {
  return {
    schema_version: 1,
    trace_id: uuidv7(),
    started_at: "2026-08-10T09:00:00.000Z",
    ended_at: "2026-08-10T09:04:00.000Z",
    apps: [{ category: "crm", origin: "acme.lightning.force.com" }],
    steps: [
      {
        order: 1,
        surface: "browser_dom",
        origin: "acme.lightning.force.com",
        path_template: "/lightning/r/Contact/:id/view",
        operation: "read_field",
        target: { role: "textbox", accessible_name: "Company Domain", ancestry: [], menu_path: [] },
        value_binding: { kind: "none" },
        preconditions: { requires_foreground: false, requires_user_presence: false },
      },
      {
        order: 2,
        surface: "browser_dom",
        origin: "acme.lightning.force.com",
        operation: "set_value",
        target: { role: "textbox", accessible_name: "Phone", ancestry: [], menu_path: [] },
        value_binding: { kind: "from_step", step: 1, output: "company_domain" },
        preconditions: { requires_foreground: true, requires_user_presence: true },
        expected_effect: { kind: "value_committed", readback: "reread_target" },
      },
    ],
    protected_segments: [],
    pattern_event_refs: [],
    local_only: true,
    ...overrides,
  };
}

describe("a trace keeps what a replay needs", () => {
  it("accepts a cross-app routine with locators, a menu path and a dataflow edge", () => {
    const t = trace({
      apps: [
        { category: "crm", origin: "acme.lightning.force.com" },
        { category: "spreadsheet", bundle_id: "com.apple.Numbers", display_name_hash: DIGEST },
      ],
      steps: [
        {
          order: 1,
          surface: "browser_dom",
          operation: "read_field",
          target: { role: "textbox", accessible_name: "Domain", ancestry: [], menu_path: [] },
          value_binding: { kind: "none" },
          preconditions: { requires_foreground: false, requires_user_presence: false },
        },
        {
          order: 2,
          surface: "macos_ax",
          app_bundle_id: "com.apple.Numbers",
          operation: "press_menu_item",
          target: {
            role: "menuItem",
            ancestry: ["Numbers"],
            menu_path: ["File", "Export To", "CSV…"],
            window_title_hash: DIGEST,
          },
          value_binding: { kind: "from_step", step: 1, output: "domain" },
          preconditions: { requires_foreground: true, requires_user_presence: true },
          expected_effect: { kind: "file_written", readback: "reread_file" },
        },
      ],
    });
    expect(localActionTrace.safeParse(t).success).toBe(true);
  });

  it("records a gap without recording what was in it", () => {
    const t = trace({
      protected_segments: [
        {
          started_at: "2026-08-10T09:01:00.000Z",
          ended_at: "2026-08-10T09:01:20.000Z",
          reason: "secure_field",
        },
      ],
    });
    const parsed = parseLocalActionTrace(t);
    expect(parsed.ok).toBe(true);
    // A hard-denied surface does not even say which app it was.
    expect(Object.keys(t.protected_segments[0]!)).not.toContain("bundle_id");
  });
});

describe("a raw value has nowhere to live", () => {
  it("refuses a step that inlines the typed text", () => {
    const t = trace();
    // The exact mistake the layer exists to prevent, written deliberately.
    (t.steps[1] as unknown as Record<string, unknown>)["value"] = "555-0199";
    const parsed = parseLocalActionTrace(t);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toContain("value");
  });

  it.each([
    ["password", "hunter2"],
    ["otp", "123456"],
    ["card_number", "4111111111111111"],
    ["cookie", "session=abc"],
    ["token", "ghp_x"],
    ["keystrokes", "abc"],
    ["screenshot", "iVBOR"],
    ["window_title", "Acme Corp — Invoice 41"],
  ])("refuses a trace carrying %s anywhere", (field, value) => {
    const t = trace() as unknown as Record<string, unknown>;
    (t["steps"] as Record<string, unknown>[])[0]!["preconditions"] = { [field]: value };
    expect(containsForbiddenTraceField(t)).toBe(field);
    expect(parseLocalActionTrace(t).ok).toBe(false);
  });

  it("a whole valid trace also passes the WorkflowEvent guard", () => {
    // The strongest statement available: the replayable layer contains nothing
    // the LOSSY layer would have refused, because bindings are refs not values.
    expect(containsForbiddenEventField(trace())).toBeNull();
  });

  it("refuses a secret-shaped control label", () => {
    // Assembled from parts rather than written as a literal. The test needs a
    // string `looksLikeSecret` matches; a credential-shaped LITERAL would also
    // trip every secret scanner that reads this repository, and pinning a
    // gitleaks fingerprint would not survive the squash-merge that rewrites the
    // commit sha it is pinned to. No literal, no finding, same assertion.
    const secretShaped = ["sk", "live", "51H8xQ2eZvKYlo2C0aBcDeFgHiJkLmNoP"].join("_");
    const t = trace();
    t.steps[0]!.target.accessible_name = secretShaped;
    expect(parseLocalActionTrace(t).ok).toBe(false);
  });
});

describe("a trace cannot be shaped into a sync payload", () => {
  it("rejects local_only: false", () => {
    const t = { ...trace(), local_only: false };
    expect(localActionTrace.safeParse(t).success).toBe(false);
  });

  it("rejects unknown fields rather than carrying them along", () => {
    const t = { ...trace(), organization_id: uuidv7() };
    expect(localActionTrace.safeParse(t).success).toBe(false);
  });
});

describe("readiness tells the compiler what to ask for", () => {
  it("is ready when every value resolves from an earlier step", () => {
    expect(traceReadiness(trace())).toEqual({ ready: true, runtime_inputs: [], problems: [] });
  });

  it("collects runtime inputs instead of guessing them", () => {
    const t = trace();
    t.steps[1]!.value_binding = {
      kind: "runtime_input",
      input_id: "new_phone",
      prompt: "Which phone number should I put in?",
    };
    const readiness = traceReadiness(t);
    expect(readiness.ready).toBe(true);
    expect(readiness.runtime_inputs).toEqual(["new_phone"]);
  });

  it("refuses a binding that reads from a later or missing step", () => {
    const forward = trace();
    forward.steps[0]!.value_binding = { kind: "from_step", step: 2, output: "x" };
    expect(traceReadiness(forward).problems[0]).toContain("later step");

    // A genuinely MISSING earlier step, not a forward one: step 3 reads from a
    // step 2 that no longer exists (the observer dropped it into a protected
    // segment, say). Order matters here — a forward reference is also absent, so
    // the forward check is the more specific answer and is reported first.
    const missing = trace();
    missing.steps[1]!.order = 3;
    missing.steps[1]!.value_binding = { kind: "from_step", step: 2, output: "x" };
    expect(traceReadiness(missing).problems[0]).toContain("missing step");
  });
});
