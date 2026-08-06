import { beforeEach, describe, expect, it } from "vitest";
import { VISION_CONFIDENCE_FLOOR, type CapturedFrame, type VisionAction } from "@maman/contracts";
import { useTeach } from "../src/state/teach.js";
import { getMemoryRawEvents } from "../src/lib/events.js";

const FRAME_ID = "018f0000-0000-7000-8000-0000000000f1";
const SESSION_ID = "018f0000-0000-7000-8000-000000000001";

function frame(over: Partial<CapturedFrame> = {}): CapturedFrame {
  return {
    schema_version: 1,
    frame_id: FRAME_ID,
    session_id: SESSION_ID,
    captured_at: "2026-08-06T12:00:00.000Z",
    bundle_id: "com.google.Chrome",
    app_category: "browser",
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

function observation(actions: VisionAction[], over: Record<string, unknown> = {}) {
  return {
    frame: frame(),
    observation: {
      schema_version: 1,
      frame_id: FRAME_ID,
      session_id: SESSION_ID,
      actions,
      uncertain: false,
      ...over,
    },
  };
}

beforeEach(() => {
  useTeach.getState().reset();
});

describe("readings accumulate but are never learned on their own", () => {
  it("arrives unreviewed, and saving nothing kept remembers nothing", async () => {
    useTeach.getState().applyObservation(observation([action()]));
    expect(useTeach.getState().readings).toHaveLength(1);
    expect(useTeach.getState().readings[0]!.verdict).toBe("unreviewed");

    await useTeach.getState().saveKept();
    expect(useTeach.getState().saved).toBe(0);
  });

  it("writes ONLY what the user kept", async () => {
    const before = getMemoryRawEvents().length;
    useTeach
      .getState()
      .applyObservation(
        observation([
          action({ label: "Close date" }),
          action({ label: "Stage", semantic_type: "status" }),
        ]),
      );
    const [first, second] = useTeach.getState().readings;
    useTeach.getState().setVerdict(first!.id, "kept");
    useTeach.getState().setVerdict(second!.id, "discarded");

    await useTeach.getState().saveKept();
    expect(useTeach.getState().saved).toBe(1);
    const written = getMemoryRawEvents().slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]!.source).toBe("teach_mode");
    expect(written[0]!.target.semantic_type).toBe("date");
  });

  it("goes through the same ingest path, so the event is a real WorkflowEvent", async () => {
    const before = getMemoryRawEvents().length;
    useTeach.getState().applyObservation(observation([action()]));
    useTeach.getState().keepAll();
    await useTeach.getState().saveKept();
    const written = getMemoryRawEvents().slice(before);
    // Teach Mode gets no shortcut into the store: it is the same insert as every
    // other source, so redaction is recorded and the source is attributable.
    expect(written[0]!.redaction).toEqual({
      applied: true,
      reasons: ["teach_mode_pre_egress_mask"],
    });
  });
});

describe("the same action seen again merges instead of doubling", () => {
  it("counts sightings and keeps the highest confidence", () => {
    // At a 2.5s cadence one field being filled appears in several frames. Three
    // sightings of one action are NOT three repetitions of the workflow.
    useTeach.getState().applyObservation(observation([action({ confidence: 0.8 })]));
    useTeach.getState().applyObservation(observation([action({ confidence: 0.95 })]));
    useTeach.getState().applyObservation(observation([action({ confidence: 0.85 })]));

    const readings = useTeach.getState().readings;
    expect(readings).toHaveLength(1);
    expect(readings[0]!.seenCount).toBe(3);
    expect(readings[0]!.confidence).toBe(0.95);
    // Every frame still counts as read, so the two numbers differ honestly.
    expect(useTeach.getState().framesRead).toBe(3);
  });

  it("does not re-ask about a reading the user already judged", () => {
    useTeach.getState().applyObservation(observation([action()]));
    const id = useTeach.getState().readings[0]!.id;
    useTeach.getState().setVerdict(id, "discarded");
    useTeach.getState().applyObservation(observation([action()]));
    expect(useTeach.getState().readings[0]!.verdict).toBe("discarded");
  });

  it("treats a different action as a different reading", () => {
    useTeach.getState().applyObservation(observation([action({ label: "Close date" })]));
    useTeach.getState().applyObservation(observation([action({ label: "Stage" })]));
    expect(useTeach.getState().readings).toHaveLength(2);
  });
});

describe("refusals are recorded so the user knows why nothing was learned", () => {
  it("summarises a repeated gate refusal with a count", () => {
    for (let i = 0; i < 3; i++) {
      useTeach.getState().applyStatus({
        session_id: SESSION_ID,
        state: "frame_refused",
        detail: "secure_field_focused",
      });
    }
    expect(useTeach.getState().skips).toEqual([{ reason: "secure_field_focused", count: 3 }]);
  });

  it("records a low-confidence answer as a skip, not a reading", () => {
    useTeach
      .getState()
      .applyObservation(observation([action({ confidence: VISION_CONFIDENCE_FLOOR - 0.01 })]));
    expect(useTeach.getState().readings).toEqual([]);
    expect(useTeach.getState().skips).toEqual([{ reason: "below_confidence_floor", count: 1 }]);
  });

  it("records the model saying it could not tell", () => {
    useTeach.getState().applyObservation(observation([action()], { uncertain: true }));
    expect(useTeach.getState().skips[0]!.reason).toBe("model_uncertain");
  });

  it("records a failed vision request without treating it as a reading", () => {
    useTeach.getState().applyStatus({
      session_id: SESSION_ID,
      state: "inference_failed",
      detail: "vision API returned status 429",
    });
    expect(useTeach.getState().readings).toEqual([]);
    expect(useTeach.getState().skips[0]!.reason).toBe("vision API returned status 429");
  });

  it("keeps the list bounded rather than growing without limit", () => {
    for (let i = 0; i < 20; i++) {
      useTeach.getState().applyStatus({ state: "frame_refused", detail: `reason_${i}` });
    }
    expect(useTeach.getState().skips.length).toBeLessThanOrEqual(6);
    // Newest first, so a current problem is not pushed off by an old one.
    expect(useTeach.getState().skips[0]!.reason).toBe("reason_19");
  });
});

describe("session lifecycle", () => {
  it("ends the session when the observer says its time box elapsed", () => {
    useTeach.setState({
      session: {
        phase: "recording",
        sessionId: SESSION_ID,
        scope: ["com.google.Chrome"],
        startedAtMs: Date.now(),
      },
    });
    useTeach.getState().applyStatus({
      session_id: SESSION_ID,
      state: "ended",
      detail: "time_box_elapsed",
    });
    expect(useTeach.getState().session).toEqual({
      phase: "ended",
      sessionId: SESSION_ID,
      reason: "time_box_elapsed",
    });
  });

  it("surfaces a refusal verbatim so the user is told what to fix", () => {
    useTeach.getState().applyStatus({
      session_id: SESSION_ID,
      state: "refused",
      detail: "screen_recording_permission_required",
    });
    expect(useTeach.getState().session).toEqual({
      phase: "refused",
      reason: "screen_recording_permission_required",
    });
  });

  it("does not end a session that is not recording", () => {
    useTeach.getState().applyStatus({ state: "ended", detail: "stopped" });
    expect(useTeach.getState().session.phase).toBe("idle");
  });

  it("clears readings and refusals on reset", () => {
    useTeach.getState().applyObservation(observation([action()]));
    useTeach.getState().applyStatus({ state: "frame_refused", detail: "paused" });
    useTeach.getState().reset();
    const state = useTeach.getState();
    expect(state.readings).toEqual([]);
    expect(state.skips).toEqual([]);
    expect(state.framesRead).toBe(0);
    expect(state.session.phase).toBe("idle");
  });

  it("refuses to start outside the desktop app rather than pretending", async () => {
    // No Tauri in a test environment, so startTeachSession rejects — and the store
    // must land in `refused` with the reason instead of a phantom `recording`.
    await useTeach.getState().start(["com.google.Chrome"], 300);
    const session = useTeach.getState().session;
    expect(session.phase).toBe("refused");
    if (session.phase !== "refused") return;
    expect(session.reason).toContain("desktop app");
  });
});
