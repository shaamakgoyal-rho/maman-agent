import { describe, expect, it } from "vitest";
import {
  containsForbiddenEventField,
  TEACH_MODE_MAX_SECONDS,
  VISION_CONFIDENCE_FLOOR,
  workflowEventSchema,
  type CapturedFrame,
  type VisionAction,
} from "@maman/contracts";
import {
  eventFromReading,
  readingsFromObservation,
  secondsRemaining,
  type TeachSessionState,
} from "../src/lib/teachMode.js";

const FRAME_ID = "018f0000-0000-7000-8000-0000000000f1";
const SESSION_ID = "018f0000-0000-7000-8000-000000000001";
const IDENTITY = {
  deviceId: "00000000-0000-7000-8000-000000000000",
  userId: "00000000-0000-7000-8000-000000000001",
  organizationId: "00000000-0000-7000-8000-000000000002",
};

function frame(over: Partial<CapturedFrame> = {}): CapturedFrame {
  return {
    schema_version: 1,
    frame_id: FRAME_ID,
    session_id: SESSION_ID,
    captured_at: "2026-08-05T12:00:00.000Z",
    bundle_id: "com.google.Chrome",
    app_category: "crm",
    width: 1400,
    height: 900,
    masked_regions: 1,
    ...over,
  };
}

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

function observation(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    frame_id: FRAME_ID,
    session_id: SESSION_ID,
    actions: [action()],
    uncertain: false,
    ...over,
  };
}

const category = () => "crm" as const;

describe("readingsFromObservation", () => {
  it("turns a confident answer into a reading the user can check", () => {
    const result = readingsFromObservation(
      { frame: frame(), observation: observation() },
      category,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readings).toHaveLength(1);
    expect(result.readings[0]).toMatchObject({
      frameId: FRAME_ID,
      description: 'filled in "Close date" on a opportunity',
      token: "teach_mode:crm:value_committed:field:date:opportunity",
      confidence: 0.9,
      seenCount: 1,
      verdict: "unreviewed",
    });
    // Identity is the ACTION, not the frame, so a repeat in the next frame merges.
    expect(result.readings[0]!.id).toContain("teach_mode:crm:value_committed");
    expect(result.readings[0]!.id).toContain("Close date");
    // The source action rides along so a kept reading can become a real event,
    // but it is never rendered.
    expect(result.readings[0]!.action.event_type).toBe("value_committed");
  });

  it("distrusts the FRAME METADATA too, not just the model's reply", () => {
    // The metadata arrives over a pipe. A bundle_id or mask count this code cannot
    // validate is not something to build a canonical event from.
    for (const bad of [
      undefined,
      {},
      { ...frame(), masked_regions: -1 },
      { ...frame(), width: 0 },
    ]) {
      const result = readingsFromObservation({ frame: bad, observation: observation() }, category);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (result.ok) continue;
      expect(result.skip.reason).toBe("invalid_frame_metadata");
    }
  });

  it("skips with a reason rather than inventing a reading", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [observation({ uncertain: true }), "model_uncertain"],
      [observation({ actions: [] }), "no_actions"],
      [observation({ actions: [action({ confidence: 0.5 })] }), "below_confidence_floor"],
      [{ nonsense: true }, "invalid_output"],
      [observation({ frame_id: "018f0000-0000-7000-8000-0000000000f2" }), "invalid_output"],
    ];
    for (const [obs, reason] of cases) {
      const result = readingsFromObservation({ frame: frame(), observation: obs }, category);
      expect(result.ok, reason).toBe(false);
      if (result.ok) continue;
      expect(result.skip.reason).toBe(reason);
      expect(result.skip.frameId).toBe(FRAME_ID);
    }
  });

  it("keeps confident readings and drops unsure ones from the same frame", () => {
    const result = readingsFromObservation(
      {
        frame: frame(),
        observation: observation({
          actions: [
            action({ label: "Close date", confidence: VISION_CONFIDENCE_FLOOR }),
            action({ label: "Stage", confidence: VISION_CONFIDENCE_FLOOR - 0.01 }),
          ],
        }),
      },
      category,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readings.map((r) => r.description)).toEqual([
      'filled in "Close date" on a opportunity',
    ]);
  });
});

describe("eventFromReading", () => {
  it("produces an event the real WorkflowEvent schema accepts", () => {
    const event = eventFromReading(frame(), action(), IDENTITY);
    const parsed = workflowEventSchema.safeParse(event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.[0])).toBe(true);
  });

  it("always attributes the reading to teach_mode", () => {
    // A vision reading can be WRONG, not merely incomplete. Anything downstream
    // weighing evidence is entitled to know which kind it is holding.
    expect(eventFromReading(frame(), action(), IDENTITY)["source"]).toBe("teach_mode");
  });

  it("carries no pixels, no values, and no typed characters", () => {
    const event = eventFromReading(frame(), action(), IDENTITY);
    // The store's own guard is the authority here; running it means this event
    // could not be rejected at insert time for a forbidden field.
    expect(containsForbiddenEventField(event)).toBeNull();
    // Random UUIDs are hex, and hex occasionally CONTAINS a forbidden
    // substring by chance ("…eb644e" failed this test in CI once). Ids carry
    // no content, so they are pinned before the scan — the scan is about what
    // the event SAYS, not about the dice.
    const scannable = { ...event, event_id: "id" };
    const serialized = JSON.stringify(scannable);
    for (const forbidden of ["jpeg", "b64", "screenshot", "pixel", "keystroke"]) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("records that a redaction pass ran, and how much it covered", () => {
    const masked = eventFromReading(frame({ masked_regions: 3 }), action(), IDENTITY);
    expect(masked["redaction"]).toEqual({
      applied: true,
      reasons: ["teach_mode_pre_egress_mask"],
    });
    const clean = eventFromReading(frame({ masked_regions: 0 }), action(), IDENTITY);
    expect(clean["redaction"]).toEqual({ applied: false, reasons: [] });
  });

  it("OMITS an unresolved role instead of asserting a null one", () => {
    // Caught by running it: workflowEventSchema marks these `.optional()` and is
    // `.strict()`, so an explicit null is rejected — and rightly, since "could not
    // tell" and "is null" are different claims.
    const vague = action({ target_role: "unknown", semantic_type: "unknown" });
    delete vague.object_type;
    const event = eventFromReading(frame(), vague, IDENTITY);
    expect(event["target"]).toEqual({});
    expect(event["context"]).toEqual({});
    const parsed = workflowEventSchema.safeParse(event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.[0])).toBe(true);
  });
});

describe("secondsRemaining", () => {
  it("counts down from the session's own bound and never goes negative", () => {
    const recording: TeachSessionState = {
      phase: "recording",
      sessionId: SESSION_ID,
      scope: ["com.google.Chrome"],
      startedAtMs: 1_000_000,
    };
    expect(secondsRemaining(recording, 300, 1_000_000)).toBe(300);
    expect(secondsRemaining(recording, 300, 1_060_000)).toBe(240);
    expect(secondsRemaining(recording, 300, 9_000_000)).toBe(0);
  });

  it("is zero unless a session is actually recording", () => {
    for (const state of [
      { phase: "idle" } as const,
      { phase: "refused", reason: "off" } as const,
      { phase: "ended", sessionId: SESSION_ID, reason: "stopped" } as const,
    ]) {
      expect(secondsRemaining(state, 300, Date.now())).toBe(0);
    }
  });

  it("never exceeds the protocol's own ceiling", () => {
    expect(TEACH_MODE_MAX_SECONDS).toBe(900);
  });
});
