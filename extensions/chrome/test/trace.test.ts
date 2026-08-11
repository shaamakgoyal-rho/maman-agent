import { describe, expect, it } from "vitest";
import { parseLocalActionTrace, traceReadiness } from "@maman/contracts";
import {
  assembleTrace,
  MAX_SESSION_OBSERVATIONS,
  pathTemplate,
  stepFrom,
  TraceSession,
  type TraceObservation,
} from "../src/lib/trace.js";

/**
 * CAPTURE MUST BE REPLAYABLE AND STILL REFUSE THE SAME THINGS.
 *
 * The trace layer exists because the semantic projection cannot address a
 * control again. These tests pin that the richer layer buys addressability
 * WITHOUT buying any of the material the semantic layer was right to refuse —
 * and that every trace this module produces passes the contract's own gate.
 */

const APPS = [{ category: "crm" as const, origin: "https://acme.lightning.force.com" }];

function obs(overrides: Partial<TraceObservation> = {}): TraceObservation {
  return {
    at: "2026-08-10T09:00:00.000Z",
    kind: "click",
    pageUrl: "https://acme.lightning.force.com/lightning/r/Contact/003ABC000001XyZ/view",
    role: "button",
    accessibleName: "Save",
    ...overrides,
  };
}

describe("a path becomes a shape, never an identifier", () => {
  it("templates record ids, uuids and Salesforce keys", () => {
    expect(pathTemplate("https://x.test/leads/48213/edit")).toBe("/leads/:id/edit");
    expect(pathTemplate("https://x.test/r/003ABC000001XyZ/view")).toBe("/r/:id/view");
    expect(pathTemplate("https://x.test/o/8f14e45f-ceea-467a-9ae3-2b5f0f1f0a11")).toBe("/o/:id");
  });

  it("keeps the structural part that identifies the workflow", () => {
    expect(pathTemplate("https://x.test/lightning/o/Account/list")).toBe(
      "/lightning/o/Account/list",
    );
  });
});

describe("a denied field becomes a hole, not a step", () => {
  it.each([
    ["password", { tag: "input", type: "password" }],
    ["card number", { tag: "input", type: "text", autocomplete: "cc-number" }],
    ["one-time code", { tag: "input", type: "text", autocomplete: "one-time-code" }],
    ["a field named secret", { tag: "input", type: "text", name: "api_secret" }],
  ])("refuses %s at capture time", (_label, field) => {
    const result = stepFrom(obs({ kind: "commit", field: field as never }), 1);
    expect(result.kind).toBe("protected");
    if (result.kind !== "protected") throw new Error("unreachable");
    expect(result.reason).toBe("secure_field");
  });

  it("records the refusal in the trace and drops no other step", () => {
    const trace = assembleTrace(
      [
        obs({ kind: "commit", accessibleName: "Phone", role: "textbox" }),
        obs({
          at: "2026-08-10T09:00:05.000Z",
          kind: "commit",
          field: { tag: "input", type: "password" } as never,
        }),
        obs({ at: "2026-08-10T09:00:10.000Z", kind: "click", accessibleName: "Save" }),
      ],
      { trace_id: "018f0000-0000-7000-8000-0000000000aa", apps: APPS },
    );
    expect(trace).not.toBeNull();
    expect(trace!.steps).toHaveLength(2);
    expect(trace!.protected_segments).toEqual([
      {
        started_at: "2026-08-10T09:00:05.000Z",
        ended_at: "2026-08-10T09:00:05.000Z",
        reason: "secure_field",
      },
    ]);
  });

  it("passes through a refusal the content script already made", () => {
    const result = stepFrom(obs({ refused: "private_browsing" }), 1);
    expect(result).toEqual({ kind: "protected", reason: "private_browsing" });
  });
});

describe("dataflow is recovered, never invented", () => {
  it("binds a paste to the step that copied it", () => {
    const trace = assembleTrace(
      [
        obs({ kind: "copy", role: "textbox", accessibleName: "Company Domain" }),
        obs({
          at: "2026-08-10T09:00:03.000Z",
          kind: "paste",
          role: "textbox",
          accessibleName: "Website",
        }),
      ],
      { trace_id: "018f0000-0000-7000-8000-0000000000bb", apps: APPS },
    )!;
    expect(trace.steps[1]!.value_binding).toEqual({
      kind: "from_step",
      step: 1,
      output: "Company Domain",
    });
    expect(traceReadiness(trace)).toMatchObject({ ready: true, runtime_inputs: [] });
  });

  it("asks instead of guessing when nothing produced the value", () => {
    const trace = assembleTrace(
      [obs({ kind: "commit", role: "textbox", accessibleName: "Phone" })],
      { trace_id: "018f0000-0000-7000-8000-0000000000cc", apps: APPS },
    )!;
    expect(trace.steps[0]!.value_binding).toEqual({
      kind: "runtime_input",
      input_id: "phone",
      prompt: "What should I put in Phone?",
    });
    // The agent is still creatable — the slot is the question, not a blocker.
    expect(traceReadiness(trace)).toMatchObject({ ready: true, runtime_inputs: ["phone"] });
  });

  it("does not carry a value across a protected hole", () => {
    // A copy, then a refused field, then a paste: binding the paste to that copy
    // would assert a dataflow that Maman did not actually see.
    const trace = assembleTrace(
      [
        obs({ kind: "copy", role: "textbox", accessibleName: "Domain" }),
        obs({
          at: "2026-08-10T09:00:02.000Z",
          kind: "commit",
          field: { tag: "input", type: "password" } as never,
        }),
        obs({
          at: "2026-08-10T09:00:04.000Z",
          kind: "paste",
          role: "textbox",
          accessibleName: "Website",
        }),
      ],
      { trace_id: "018f0000-0000-7000-8000-0000000000dd", apps: APPS },
    )!;
    expect(trace.steps[1]!.value_binding.kind).toBe("runtime_input");
  });

  it("consumes a copied value once", () => {
    const trace = assembleTrace(
      [
        obs({ kind: "copy", role: "textbox", accessibleName: "Domain" }),
        obs({
          at: "2026-08-10T09:00:02.000Z",
          kind: "paste",
          role: "textbox",
          accessibleName: "A",
        }),
        obs({
          at: "2026-08-10T09:00:04.000Z",
          kind: "paste",
          role: "textbox",
          accessibleName: "B",
        }),
      ],
      { trace_id: "018f0000-0000-7000-8000-0000000000ee", apps: APPS },
    )!;
    expect(trace.steps[1]!.value_binding.kind).toBe("from_step");
    expect(trace.steps[2]!.value_binding.kind).toBe("runtime_input");
  });
});

describe("what capture produces is what the contract accepts", () => {
  it("every assembled trace passes the contract gate, including the field scan", () => {
    const trace = assembleTrace(
      [
        obs({ kind: "read", role: "textbox", accessibleName: "Company Domain" }),
        obs({
          at: "2026-08-10T09:00:02.000Z",
          kind: "paste",
          role: "textbox",
          accessibleName: "Website",
        }),
        obs({ at: "2026-08-10T09:00:06.000Z", kind: "click", accessibleName: "Save" }),
      ],
      { trace_id: "018f0000-0000-7000-8000-0000000000ff", apps: APPS },
    )!;
    const parsed = parseLocalActionTrace(trace);
    expect(parsed.ok, parsed.ok ? "" : parsed.reason).toBe(true);
  });

  it("marks writes as needing the foreground and a present user", () => {
    const trace = assembleTrace(
      [obs({ kind: "commit", role: "textbox", accessibleName: "Phone" })],
      {
        trace_id: "018f0000-0000-7000-8000-000000000101",
        apps: APPS,
      },
    )!;
    expect(trace.steps[0]!.preconditions).toMatchObject({
      requires_foreground: true,
      requires_user_presence: true,
    });
    // …and that a write states how it will be independently checked.
    expect(trace.steps[0]!.expected_effect).toEqual({
      kind: "value_committed",
      readback: "reread_target",
    });
  });

  it("returns null rather than an empty trace when everything was refused", () => {
    const trace = assembleTrace(
      [obs({ kind: "commit", field: { tag: "input", type: "password" } as never })],
      { trace_id: "018f0000-0000-7000-8000-000000000102", apps: APPS },
    );
    expect(trace).toBeNull();
  });
});

describe("a session buffers until the caller flushes", () => {
  const newId = () => "018f0000-0000-7000-8000-000000000abc";

  it("assembles what it buffered and empties itself", () => {
    const session = new TraceSession(newId);
    expect(session.push(obs({ kind: "copy", role: "textbox", accessibleName: "Domain" }))).toBe(
      false,
    );
    session.push(obs({ kind: "paste", role: "textbox", accessibleName: "Website" }));
    expect(session.size).toBe(2);

    const trace = session.flush(APPS)!;
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[1]!.value_binding.kind).toBe("from_step");
    // Flushing clears, so the next session cannot re-send the same work.
    expect(session.size).toBe(0);
    expect(session.flush(APPS)).toBeNull();
  });

  it("asks the caller to flush at the cap instead of growing forever", () => {
    const session = new TraceSession(newId);
    let asked = false;
    for (let i = 0; i < MAX_SESSION_OBSERVATIONS + 10; i += 1) {
      asked = session.push(obs({ kind: "click" })) || asked;
    }
    expect(asked).toBe(true);
    expect(session.size).toBe(MAX_SESSION_OBSERVATIONS);
  });

  it("produces nothing from a session that was entirely refused", () => {
    const session = new TraceSession(newId);
    session.push(obs({ kind: "commit", field: { tag: "input", type: "password" } as never }));
    expect(session.flush(APPS)).toBeNull();
  });
});
