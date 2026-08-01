import { describe, expect, it } from "vitest";
import type { PatternFeatureEvent } from "@maman/contracts";
import { segmentEpisodes, canonicalToken } from "../src/segmentation.js";

let counter = 0;
function evt(overrides: Partial<PatternFeatureEvent> = {}): PatternFeatureEvent {
  counter++;
  return {
    event_id: `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    occurred_at: "2026-07-14T10:00:00.000Z",
    monotonic_ms: counter * 1000,
    source: "demo",
    app_category: "crm",
    event_type: "record_opened",
    target_role: "row",
    object_type: "account",
    duration_ms: 5_000,
    sensitivity: "internal",
    excluded_from_learning: false,
    ...overrides,
  };
}

function at(iso: string, overrides: Partial<PatternFeatureEvent> = {}) {
  return evt({ occurred_at: iso, ...overrides });
}

describe("episode segmentation", () => {
  it("returns nothing for an empty event stream", () => {
    expect(segmentEpisodes([])).toEqual([]);
  });

  it("discards candidates with fewer than three events", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z"),
      at("2026-07-14T10:00:10.000Z"),
    ]);
    expect(episodes).toEqual([]);
  });

  it("discards candidates with less than ten seconds of active time", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z", { duration_ms: 2000 }),
      at("2026-07-14T10:00:03.000Z", { duration_ms: 2000 }),
      at("2026-07-14T10:00:06.000Z", { duration_ms: 2000 }),
    ]);
    expect(episodes).toEqual([]);
  });

  it("keeps a valid minimal episode", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z"),
      at("2026-07-14T10:00:10.000Z"),
      at("2026-07-14T10:00:20.000Z"),
    ]);
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.active_duration_ms).toBe(15_000);
    expect(episodes[0]!.canonical_tokens.length).toBe(3);
  });

  it("splits on idle_started boundaries", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z"),
      at("2026-07-14T10:00:10.000Z"),
      at("2026-07-14T10:00:20.000Z"),
      at("2026-07-14T10:00:30.000Z", { event_type: "idle_started", duration_ms: 0 }),
      at("2026-07-14T10:10:00.000Z"),
      at("2026-07-14T10:10:10.000Z"),
      at("2026-07-14T10:10:20.000Z"),
    ]);
    expect(episodes.length).toBe(2);
  });

  it("splits on denied-context boundaries (boundary_redacted)", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z"),
      at("2026-07-14T10:00:10.000Z"),
      at("2026-07-14T10:00:20.000Z"),
      at("2026-07-14T10:00:25.000Z", {
        event_type: "boundary_redacted",
        sensitivity: "restricted",
        duration_ms: 0,
      }),
      at("2026-07-14T10:01:00.000Z"),
      at("2026-07-14T10:01:10.000Z"),
      at("2026-07-14T10:01:20.000Z"),
    ]);
    expect(episodes.length).toBe(2);
    // The boundary event itself is not workflow content and does not taint
    // either side with restricted sensitivity.
    for (const episode of episodes) {
      expect(episode.sensitivity_max).toBe("internal");
      expect(episode.events.some((e) => e.event_type === "boundary_redacted")).toBe(false);
    }
  });

  it("splits when the gap between events exceeds ten minutes", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z"),
      at("2026-07-14T10:00:10.000Z"),
      at("2026-07-14T10:00:20.000Z"),
      at("2026-07-14T10:11:00.000Z"),
      at("2026-07-14T10:11:10.000Z"),
      at("2026-07-14T10:11:20.000Z"),
    ]);
    expect(episodes.length).toBe(2);
  });

  it("splits on more than five minutes of inactivity beyond event duration", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z", { duration_ms: 10_000 }),
      at("2026-07-14T10:00:10.000Z", { duration_ms: 10_000 }),
      at("2026-07-14T10:00:20.000Z", { duration_ms: 10_000 }),
      // 8 minute gap, 10s of it explained by duration → 7m50s inactivity
      at("2026-07-14T10:08:20.000Z", { duration_ms: 10_000 }),
      at("2026-07-14T10:08:30.000Z", { duration_ms: 10_000 }),
      at("2026-07-14T10:08:40.000Z", { duration_ms: 10_000 }),
    ]);
    expect(episodes.length).toBe(2);
  });

  it("splits when the business object family changes after three or more events", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z", { object_type: "account" }),
      at("2026-07-14T10:00:10.000Z", { object_type: "account" }),
      at("2026-07-14T10:00:20.000Z", { object_type: "account" }),
      at("2026-07-14T10:00:30.000Z", { object_type: "opportunity" }),
      at("2026-07-14T10:00:40.000Z", { object_type: "opportunity" }),
      at("2026-07-14T10:00:50.000Z", { object_type: "opportunity" }),
    ]);
    expect(episodes.length).toBe(2);
  });

  it("does NOT split on object change before three events", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z", { object_type: "account" }),
      at("2026-07-14T10:00:10.000Z", { object_type: "opportunity" }),
      at("2026-07-14T10:00:20.000Z", { object_type: "opportunity" }),
      at("2026-07-14T10:00:30.000Z", { object_type: "opportunity" }),
    ]);
    expect(episodes.length).toBe(1);
  });

  it("tolerates out-of-order timestamps (sorts deterministically)", () => {
    const events = [
      at("2026-07-14T10:00:20.000Z"),
      at("2026-07-14T10:00:00.000Z"),
      at("2026-07-14T10:00:10.000Z"),
    ];
    const episodes = segmentEpisodes(events);
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.started_at).toBe("2026-07-14T10:00:00.000Z");
    expect(episodes[0]!.ended_at).toBe("2026-07-14T10:00:20.000Z");
  });

  it("marks the episode excluded when any event is excluded from learning", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z"),
      at("2026-07-14T10:00:10.000Z", { excluded_from_learning: true }),
      at("2026-07-14T10:00:20.000Z"),
    ]);
    expect(episodes[0]!.excluded_from_learning).toBe(true);
  });

  it("propagates the maximum sensitivity", () => {
    const episodes = segmentEpisodes([
      at("2026-07-14T10:00:00.000Z", { sensitivity: "public" }),
      at("2026-07-14T10:00:10.000Z", { sensitivity: "restricted" }),
      at("2026-07-14T10:00:20.000Z", { sensitivity: "internal" }),
    ]);
    expect(episodes[0]!.sensitivity_max).toBe("restricted");
  });

  it("canonical tokens exclude ids, labels, values, timestamps, and counts", () => {
    const token = canonicalToken(
      evt({
        source: "chrome",
        app_category: "crm",
        event_type: "record_opened",
        target_role: "row",
        semantic_type: "account",
        object_type: "account",
        item_count_bucket: "11_50",
        duration_ms: 12345,
      }),
    );
    expect(token).toBe("chrome:crm:record_opened:row:account:account");
    expect(token).not.toMatch(/11_50|12345|2026/);
  });
});

describe("derived durations (live events without duration_ms)", () => {
  let liveCounter = 1000;
  function liveEvt(iso: string, overrides: Partial<PatternFeatureEvent> = {}): PatternFeatureEvent {
    liveCounter++;
    // No duration_ms — matches what the AX observer and browser relay emit.
    return {
      event_id: `00000000-0000-7000-8000-${String(liveCounter).padStart(12, "0")}`,
      occurred_at: iso,
      monotonic_ms: liveCounter * 1000,
      source: "chrome",
      app_category: "crm",
      event_type: "value_committed",
      target_role: "input",
      semantic_type: "account_name",
      sensitivity: "internal",
      excluded_from_learning: false,
      ...overrides,
    };
  }

  it("forms an episode from live events by deriving active time from spacing", () => {
    const episodes = segmentEpisodes([
      liveEvt("2026-07-14T10:00:00.000Z"),
      liveEvt("2026-07-14T10:00:08.000Z"),
      liveEvt("2026-07-14T10:00:16.000Z"),
    ]);
    expect(episodes.length).toBe(1);
    // 8s + 8s derived + 1s trailing credit = 17s of active time.
    expect(episodes[0]!.active_duration_ms).toBe(17_000);
  });

  it("caps derived per-event active time so long gaps never inflate it", () => {
    const episodes = segmentEpisodes([
      liveEvt("2026-07-14T10:00:00.000Z"),
      liveEvt("2026-07-14T10:02:00.000Z"), // 120s gap → capped at 30s
      liveEvt("2026-07-14T10:02:10.000Z"),
    ]);
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.active_duration_ms).toBe(30_000 + 10_000 + 1_000);
  });

  it("never overrides a recorded duration_ms", () => {
    const episodes = segmentEpisodes([
      liveEvt("2026-07-14T10:00:00.000Z", { duration_ms: 4_000 }),
      liveEvt("2026-07-14T10:00:20.000Z", { duration_ms: 4_000 }),
      liveEvt("2026-07-14T10:00:40.000Z", { duration_ms: 4_000 }),
    ]);
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.active_duration_ms).toBe(12_000);
  });
});

describe("segmentation options", () => {
  let optCounter = 2000;
  function optEvt(iso: string, overrides: Partial<PatternFeatureEvent> = {}): PatternFeatureEvent {
    optCounter++;
    return {
      event_id: `00000000-0000-7000-8000-${String(optCounter).padStart(12, "0")}`,
      occurred_at: iso,
      monotonic_ms: optCounter * 1000,
      source: "chrome",
      app_category: "crm",
      event_type: "navigation",
      duration_ms: 5_000,
      sensitivity: "internal",
      excluded_from_learning: false,
      ...overrides,
    };
  }

  it("honors a tightened event-gap boundary", () => {
    const run = (start: string) => [
      optEvt(start),
      optEvt(start.replace("00.000Z", "10.000Z"), { event_type: "element_activated" }),
      optEvt(start.replace("00.000Z", "20.000Z"), { event_type: "value_committed" }),
    ];
    const events = [...run("2026-07-14T10:00:00.000Z"), ...run("2026-07-14T10:02:00.000Z")];
    // Default 10-minute gap boundary: one merged episode.
    expect(segmentEpisodes(events).length).toBe(1);
    // 90-second boundary: the 100s gap between runs splits them.
    expect(segmentEpisodes(events, { event_gap_boundary_ms: 90_000 }).length).toBe(2);
  });

  it("splits back-to-back repetitions on sequence restart when opted in", () => {
    const run = (s0: string, s1: string, s2: string) => [
      optEvt(s0),
      optEvt(s1, { event_type: "element_activated" }),
      optEvt(s2, { event_type: "value_committed" }),
    ];
    const events = [
      ...run("2026-07-14T10:00:00.000Z", "2026-07-14T10:00:10.000Z", "2026-07-14T10:00:20.000Z"),
      ...run("2026-07-14T10:00:30.000Z", "2026-07-14T10:00:40.000Z", "2026-07-14T10:00:50.000Z"),
      ...run("2026-07-14T10:01:00.000Z", "2026-07-14T10:01:10.000Z", "2026-07-14T10:01:20.000Z"),
    ];
    // Without the option the reps merge into one long episode.
    expect(segmentEpisodes(events).length).toBe(1);
    const split = segmentEpisodes(events, { split_on_sequence_restart: true });
    expect(split.length).toBe(3);
    expect(split.every((e) => e.canonical_tokens.length === 3)).toBe(true);
  });
});
