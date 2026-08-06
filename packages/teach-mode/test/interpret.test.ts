import { describe, expect, it } from "vitest";
import {
  visionActionSchema,
  visionObservationSchema,
  VISION_CONFIDENCE_FLOOR,
  type VisionAction,
} from "@maman/contracts";
import {
  canonicalTokenFor,
  canonicalTokens,
  describeAction,
  interpretVisionResponse,
} from "../src/index.js";

const FRAME = "018f0000-0000-7000-8000-0000000000f1";
const SESSION = "018f0000-0000-7000-8000-000000000001";
const EXPECT = { frameId: FRAME, sessionId: SESSION };

function action(over: Partial<VisionAction> = {}): VisionAction {
  return {
    event_type: "value_committed",
    target_role: "field",
    semantic_type: "date",
    object_type: "opportunity",
    label: "Close date",
    confidence: 0.9,
    ...over,
  };
}

function response(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    frame_id: FRAME,
    session_id: SESSION,
    actions: [action()],
    uncertain: false,
    ...over,
  };
}

describe("the model may not assert anything but what it saw", () => {
  it("rejects a response trying to set risk, eligibility, permissions or value", () => {
    // The security boundary is the FIELD LIST: there is nowhere to put these, and
    // .strict() refuses rather than ignoring them.
    for (const smuggled of [
      { risk: "low" },
      { risk_score: 0.1 },
      { eligible: true },
      { automatable: true },
      { capability_id: "salesforce.update_fields" },
      { permission: "write" },
      { minutes_saved: 90 },
      { value_usd: 1000 },
      { requires_approval: false },
    ]) {
      const parsed = visionActionSchema.safeParse({ ...action(), ...smuggled });
      expect(parsed.success, JSON.stringify(smuggled)).toBe(false);
    }
  });

  it("rejects an event type outside the existing canonical vocabulary", () => {
    expect(visionActionSchema.safeParse({ ...action(), event_type: "wired_money" }).success).toBe(
      false,
    );
  });

  it("rejects a label carrying secret-shaped content read off the screen", () => {
    // A redaction pass that missed something must not get a second chance to
    // launder it back through the model's description of what it saw.
    expect(
      visionActionSchema.safeParse({ ...action(), label: "AKIAIOSFODNN7EXAMPLE" }).success,
    ).toBe(false);
    expect(
      visionActionSchema.safeParse({ ...action(), label: `sk-ant-${"x".repeat(30)}` }).success,
    ).toBe(false);
  });

  it("has no field that could carry a typed value or keystrokes", () => {
    const keys = Object.keys(visionActionSchema.shape);
    for (const forbidden of ["value", "text", "keystrokes", "screenshot", "password", "content"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it("caps how many actions one frame may claim", () => {
    const many = Array.from({ length: 9 }, () => action());
    expect(visionObservationSchema.safeParse(response({ actions: many })).success).toBe(false);
  });
});

describe("interpretVisionResponse", () => {
  it("accepts a valid, confident response", () => {
    const result = interpretVisionResponse(response(), EXPECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toHaveLength(1);
  });

  it("rejects malformed output whole rather than salvaging the good parts", () => {
    const half = response({ actions: [action(), { event_type: "value_committed" }] });
    const result = interpretVisionResponse(half, EXPECT);
    expect(result).toMatchObject({ ok: false, reason: "invalid_output" });
  });

  it("rejects a response describing a different frame or session", () => {
    expect(
      interpretVisionResponse(
        response({ frame_id: "018f0000-0000-7000-8000-0000000000f2" }),
        EXPECT,
      ),
    ).toMatchObject({ ok: false, detail: "the response describes a different frame" });
    expect(
      interpretVisionResponse(
        response({ session_id: "018f0000-0000-7000-8000-000000000002" }),
        EXPECT,
      ),
    ).toMatchObject({ ok: false, detail: "the response describes a different frame" });
  });

  it("honours the model saying it could not tell", () => {
    expect(interpretVisionResponse(response({ uncertain: true }), EXPECT)).toEqual({
      ok: false,
      reason: "model_uncertain",
    });
  });

  it("treats an empty action list as a normal answer, not an error", () => {
    expect(interpretVisionResponse(response({ actions: [] }), EXPECT)).toEqual({
      ok: false,
      reason: "no_actions",
    });
  });

  it("DROPS a low-confidence action rather than recording it with a caveat", () => {
    const unsure = response({ actions: [action({ confidence: VISION_CONFIDENCE_FLOOR - 0.01 })] });
    expect(interpretVisionResponse(unsure, EXPECT)).toMatchObject({
      ok: false,
      reason: "below_confidence_floor",
    });
  });

  it("accepts exactly at the floor", () => {
    const borderline = response({ actions: [action({ confidence: VISION_CONFIDENCE_FLOOR })] });
    expect(interpretVisionResponse(borderline, EXPECT).ok).toBe(true);
  });

  it("keeps the confident actions and drops the unsure ones from the same frame", () => {
    const mixed = response({
      actions: [
        action({ label: "Close date", confidence: 0.95 }),
        action({ label: "Stage", confidence: 0.4 }),
      ],
    });
    const result = interpretVisionResponse(mixed, EXPECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions.map((a) => a.label)).toEqual(["Close date"]);
  });

  it("rejects a non-object entirely", () => {
    for (const junk of [null, "text", 7, [], undefined]) {
      expect(interpretVisionResponse(junk, EXPECT).ok).toBe(false);
    }
  });
});

describe("canonical tokens keep vision in the existing vocabulary", () => {
  it("builds the same six-field token every other source builds", () => {
    expect(canonicalTokenFor(action(), "crm")).toBe(
      "teach_mode:crm:value_committed:field:date:opportunity",
    );
  });

  it("writes - for anything absent, rather than omitting a field", () => {
    const vague = action({ target_role: "unknown", semantic_type: "unknown" });
    delete vague.object_type;
    expect(canonicalTokenFor(vague, "crm")).toBe("teach_mode:crm:value_committed:-:-:-");
  });

  it("always has six colon-separated fields", () => {
    for (const a of [action(), action({ target_role: "unknown" })]) {
      expect(canonicalTokenFor(a, "spreadsheet").split(":")).toHaveLength(6);
    }
  });

  it("maps a list of actions in order", () => {
    const tokens = canonicalTokens(
      [action({ event_type: "record_opened" }), action({ event_type: "value_committed" })],
      "crm",
    );
    expect(tokens[0]).toContain("record_opened");
    expect(tokens[1]).toContain("value_committed");
  });

  it("names teach_mode as the source, so provenance is never ambiguous", () => {
    // A vision-derived reading can be WRONG rather than merely incomplete, so it
    // must always be distinguishable from an accessibility-derived one.
    expect(canonicalTokenFor(action(), "crm").startsWith("teach_mode:")).toBe(true);
  });
});

describe("describeAction", () => {
  it("says what happened in plain words the user can check", () => {
    expect(describeAction(action())).toBe('filled in "Close date" on a opportunity');
    expect(
      describeAction(action({ event_type: "record_opened", label: "Northwind Traders" })),
    ).toBe('opened the record for "Northwind Traders" on a opportunity');
  });

  it("falls back to the role when nothing was labelled", () => {
    const unlabelled = action({ target_role: "button" });
    delete unlabelled.label;
    delete unlabelled.object_type;
    expect(describeAction(unlabelled)).toBe("filled in button");
  });

  it("never includes a value, because none is ever captured", () => {
    // The schema has no value field at all; this pins that the description cannot
    // acquire one by another route.
    expect(describeAction(action())).not.toContain("2026");
  });

  it("has a phrase for every event type in the vocabulary", () => {
    for (const eventType of visionActionSchema.shape.event_type.options) {
      const described = describeAction(action({ event_type: eventType }));
      expect(described, eventType).not.toContain("acted on");
    }
  });
});
