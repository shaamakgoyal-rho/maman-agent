import { beforeEach, describe, expect, it } from "vitest";
import type { CapturedFrame, VisionAction } from "@maman/contracts";
import { visionSessionPrice } from "@maman/model-provider";
import { useTeach } from "../src/state/teach.js";
import { useSettings } from "../src/state/settings.js";

const FRAME_ID = "018f0000-0000-7000-8000-0000000000f1";
const SESSION_ID = "018f0000-0000-7000-8000-000000000001";

function frame(): CapturedFrame {
  return {
    schema_version: 1,
    frame_id: FRAME_ID,
    session_id: SESSION_ID,
    captured_at: "2026-08-06T12:00:00.000Z",
    bundle_id: "com.google.Chrome",
    app_category: "browser",
    width: 1400,
    height: 933,
    masked_regions: 0,
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

function payload(opts: {
  actions?: VisionAction[];
  usage?: { input_tokens: number; output_tokens: number };
  uncertain?: boolean;
}) {
  return {
    frame: frame(),
    observation: {
      schema_version: 1,
      frame_id: FRAME_ID,
      session_id: SESSION_ID,
      actions: opts.actions ?? [action()],
      uncertain: opts.uncertain ?? false,
    },
    ...(opts.usage === undefined ? {} : { usage: opts.usage }),
  };
}

function setModel(alias: string) {
  useSettings.setState({
    settings: { ...useSettings.getState().settings, vision_model_alias: alias },
  });
}

beforeEach(() => {
  useTeach.getState().reset();
  setModel("claude-sonnet-5");
});

describe("a session reports what it actually spent", () => {
  it("accumulates the token counts the API reported", () => {
    useTeach
      .getState()
      .applyObservation(payload({ usage: { input_tokens: 2187, output_tokens: 128 } }));
    useTeach
      .getState()
      .applyObservation(payload({ usage: { input_tokens: 2190, output_tokens: 96 } }));
    const spend = useTeach.getState().spend;
    expect(spend.frames).toBe(2);
    expect(spend.inputTokens).toBe(4377);
    expect(spend.outputTokens).toBe(224);
    expect(spend.costUsd).toBeGreaterThan(0);
  });

  it("charges for a frame the model could NOT read", () => {
    // A spend total that only counted successes would understate the bill: an
    // uncertain answer costs exactly what a useful one costs.
    useTeach
      .getState()
      .applyObservation(
        payload({ uncertain: true, usage: { input_tokens: 2187, output_tokens: 40 } }),
      );
    expect(useTeach.getState().readings).toHaveLength(0);
    expect(useTeach.getState().spend.frames).toBe(1);
    expect(useTeach.getState().spend.inputTokens).toBe(2187);
  });

  it("charges for a frame whose reading was below the confidence floor", () => {
    useTeach.getState().applyObservation(
      payload({
        actions: [action({ confidence: 0.2 })],
        usage: { input_tokens: 2187, output_tokens: 80 },
      }),
    );
    expect(useTeach.getState().readings).toHaveLength(0);
    expect(useTeach.getState().spend.costUsd).toBeGreaterThan(0);
  });

  it("stays at zero when the core reported no usage", () => {
    useTeach.getState().applyObservation(payload({}));
    expect(useTeach.getState().spend).toEqual({
      frames: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("prices with the configured model, so a dearer model reads dearer", () => {
    const usage = { input_tokens: 100_000, output_tokens: 10_000 };
    useTeach.getState().applyObservation(payload({ usage }));
    const sonnet = useTeach.getState().spend.costUsd;

    useTeach.getState().reset();
    setModel("claude-haiku-4-5-20251001");
    useTeach.getState().applyObservation(payload({ usage }));
    const haiku = useTeach.getState().spend.costUsd;

    expect(haiku).toBeLessThan(sonnet);
  });

  it("clears the running total when a new session starts", async () => {
    useTeach
      .getState()
      .applyObservation(payload({ usage: { input_tokens: 2187, output_tokens: 128 } }));
    expect(useTeach.getState().spend.frames).toBe(1);
    // start() refuses outside Tauri, but must still have cleared the previous total.
    await useTeach.getState().start(["com.google.Chrome"], 300);
    expect(useTeach.getState().spend.frames).toBe(0);
  });
});

describe("visionSessionPrice never understates an unpriced model", () => {
  it("prices a known alias from the table", () => {
    expect(visionSessionPrice("claude-sonnet-5")).toEqual({
      input_per_mtok_usd: 3,
      output_per_mtok_usd: 15,
    });
  });

  it("falls back to the DEAREST known price for an unknown alias", () => {
    // Quoting $0 for a model that will really be billed is the wrong direction to
    // be wrong in, for the one feature that sends pictures of a screen somewhere.
    const unknown = visionSessionPrice("claude-something-unreleased");
    expect(unknown.input_per_mtok_usd).toBe(15);
    expect(unknown.output_per_mtok_usd).toBe(75);
  });

  it("is genuinely free only when nothing is configured", () => {
    expect(visionSessionPrice("")).toEqual({ input_per_mtok_usd: 0, output_per_mtok_usd: 0 });
    expect(visionSessionPrice("demo")).toEqual({ input_per_mtok_usd: 0, output_per_mtok_usd: 0 });
  });
});
