/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { runtimeFromRegistry, validateRuntimeCapabilities } from "@maman/agent-runtime";
import type { AgentSpec } from "@maman/contracts";

/**
 * The wiring that flips a browser workflow from "cannot run here" to runnable.
 *
 * `browser.propose_form_fill` and `browser.supervised_form_fill` had no adapter
 * anywhere, so the compiler correctly refused them as `needs_runtime` and the
 * device's browser cards could not become agents. These tests pin the two halves
 * of the fix: the adapters ARE in the run registry once the user names an
 * origin, and they are ABSENT while no origin is named — so the refusal is
 * about configuration rather than a missing implementation.
 */

const invoked: string[] = [];
/** What the system idle clock reports, in seconds — the presence signal. */
let idleSeconds = 0;
vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => true,
  invokeCommand: async (cmd: string) => {
    invoked.push(cmd);
    if (cmd === "agent_browser_origin") return "https://acme.example";
    if (cmd === "user_idle_seconds") return idleSeconds;
    return undefined;
  },
  emitAppEvent: async () => undefined,
}));

const { useRuns, __testRegistryFor, userIsPresent } = await import("../src/lib/runs.js");
const { refreshPresence, __resetPresenceForTests } = await import("../src/lib/presence.js");

const ORIGIN = "https://acme.example";

/** A spec whose steps are exactly the browser fill loop. */
const browserSpec = {
  steps: [
    {
      step_id: "read",
      order: 1,
      name: "Read the fields",
      capability_id: "browser.extract_structured_fields",
      capability_version: 1,
      mode: "read",
      inputs: {},
      output_key: "fields",
      risk_level: "low",
      approval: { required: false },
      retry: { allowed: true, max_attempts: 3, backoff_seconds: [1] },
    },
    {
      step_id: "propose",
      order: 2,
      name: "Propose the fill",
      capability_id: "browser.propose_form_fill",
      capability_version: 1,
      mode: "propose_write",
      inputs: {},
      output_key: "proposal",
      risk_level: "low",
      approval: { required: false },
      retry: { allowed: false, max_attempts: 0, backoff_seconds: [] },
    },
    {
      step_id: "fill",
      order: 3,
      name: "Fill after approval",
      capability_id: "browser.supervised_form_fill",
      capability_version: 1,
      mode: "write",
      inputs: {},
      output_key: "result",
      risk_level: "high",
      approval: { required: true },
      retry: { allowed: false, max_attempts: 0, backoff_seconds: [] },
    },
  ],
} as unknown as Pick<AgentSpec, "steps">;

beforeEach(() => {
  invoked.length = 0;
  useRuns.getState().reset();
});

describe("naming an origin makes the browser lane runnable", () => {
  it("WITHOUT an origin, the browser capabilities are absent", () => {
    // The honest state on a fresh machine: actuation is off until the user
    // names a site, so a browser plan is refused before anything executes.
    const runtime = runtimeFromRegistry("local-demo", __testRegistryFor([]));
    const readiness = validateRuntimeCapabilities(browserSpec, runtime);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing.map((m) => m.capability_id)).toEqual([
      "browser.extract_structured_fields",
      "browser.propose_form_fill",
      "browser.supervised_form_fill",
    ]);
    expect(readiness.missing.every((m) => m.reason === "no_adapter")).toBe(true);
  });

  it("WITH an origin, every step of the fill loop has an adapter", () => {
    const runtime = runtimeFromRegistry("local-demo", __testRegistryFor([ORIGIN]));
    expect(validateRuntimeCapabilities(browserSpec, runtime).ready).toBe(true);
  });

  it("each capability is registered in the MODE its step needs", () => {
    // An adapter present but lacking write() would let a write silently degrade
    // into a no-op that still reports success.
    const runtime = runtimeFromRegistry("local-demo", __testRegistryFor([ORIGIN]));
    expect(runtime.modes.get("browser.supervised_form_fill")).toContain("write");
    expect(runtime.modes.get("browser.propose_form_fill")).toContain("propose_write");
    expect(runtime.modes.get("browser.extract_structured_fields")).toContain("read");
  });

  it("does not disturb the Salesforce adapters it sits beside", () => {
    // Different capability ids, so nothing falls back between demo and real: a
    // browser step can never be served by the demo world, and vice versa.
    const withBrowser = __testRegistryFor([ORIGIN]);
    for (const id of ["salesforce.query_records", "salesforce.update_fields", "local.parse_csv"]) {
      expect(withBrowser.has(id), id).toBe(true);
    }
  });

  it("still refuses browser.extract_table, which has no honest implementation", () => {
    // An unbounded table read is an unbounded page read. Registering a
    // half-answer would let the compiler emit it and the gate would then pass.
    const runtime = runtimeFromRegistry("local-demo", __testRegistryFor([ORIGIN]));
    const readiness = validateRuntimeCapabilities(
      {
        steps: [
          {
            step_id: "t",
            order: 1,
            name: "Read a table",
            capability_id: "browser.extract_table",
            capability_version: 1,
            mode: "read",
            inputs: {},
            output_key: "t",
            risk_level: "low",
            approval: { required: false },
            retry: { allowed: true, max_attempts: 3, backoff_seconds: [1] },
          },
        ],
      } as unknown as Pick<AgentSpec, "steps">,
      runtime,
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing[0]!.reason).toBe("no_adapter");
  });
});

describe("presence is observed, never assumed", () => {
  /**
   * Presence now comes from the SYSTEM IDLE CLOCK, not from whether Maman's
   * panel is in front — panel visibility inverted the question (a user typing
   * in Chrome read as absent; a user at lunch with the panel open read as
   * present). Full semantics live in test/presence.test.ts; here we pin the
   * two properties the actuator wiring depends on.
   */
  it("fails closed in the desktop app until the idle clock has answered", () => {
    // A hardcoded `true` would REMOVE the presence check rather than satisfy
    // it: the pure actuator refuses a consequential write without presence,
    // and an unanswered presence question is not presence.
    __resetPresenceForTests();
    expect(userIsPresent()).toBe(false);
  });

  it("is evaluated per call, so walking away between approval and write counts", async () => {
    // The predicate is captured as a FUNCTION, not a value: presence at
    // approval time must not authorise a write performed later.
    idleSeconds = 2;
    await refreshPresence();
    expect(userIsPresent()).toBe(true);

    idleSeconds = 60 * 60; // the user left
    await refreshPresence();
    expect(userIsPresent()).toBe(false);
  });
});
