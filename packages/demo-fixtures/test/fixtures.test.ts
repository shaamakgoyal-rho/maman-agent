import { describe, expect, it } from "vitest";
import { workflowEventSchema } from "@maman/contracts";
import { reconciliationFixture, unrelatedFixture } from "../src/index.js";

describe("reconciliationFixture", () => {
  const events = reconciliationFixture();

  it("is deterministic for the same seed", () => {
    expect(reconciliationFixture()).toEqual(events);
    expect(reconciliationFixture({ seed: 42 })).not.toEqual(events);
  });

  it("emits schema-valid events only", () => {
    for (const e of events) expect(workflowEventSchema.parse(e)).toBeTruthy();
  });

  it("contains six episodes across exactly three distinct days", () => {
    const idles = events.filter((e) => e.event_type === "idle_started");
    expect(idles.length).toBe(6);
    const days = new Set(events.map((e) => e.occurred_at.slice(0, 10)));
    expect(days.size).toBe(3);
  });

  it("each episode takes between 8 and 14 simulated active minutes", () => {
    // active time = sum of step durations between idle boundaries
    let activeMs = 0;
    const perEpisode: number[] = [];
    for (const e of events) {
      if (e.event_type === "idle_started") {
        perEpisode.push(activeMs);
        activeMs = 0;
      } else {
        activeMs += e.duration_ms ?? 0;
      }
    }
    expect(perEpisode.length).toBe(6);
    for (const ms of perEpisode) {
      expect(ms).toBeGreaterThanOrEqual(8 * 60_000);
      expect(ms).toBeLessThanOrEqual(14 * 60_000);
    }
  });

  it("episodes vary slightly (not byte-identical sequences)", () => {
    const episodes: string[][] = [[]];
    for (const e of events) {
      if (e.event_type === "idle_started") episodes.push([]);
      else episodes[episodes.length - 1]!.push(e.event_type);
    }
    const signatures = new Set(episodes.slice(0, 6).map((ep) => ep.join(",")));
    // variation steps produce at least two distinct shapes
    expect(signatures.size).toBeGreaterThanOrEqual(2);
  });

  it("never contains raw values, tokens, or forbidden content fields", () => {
    const json = JSON.stringify(events);
    expect(json).not.toMatch(/password|keystroke|clipboard|screenshot/i);
  });

  it("spans Sheets and Salesforce with the expected verbs", () => {
    const types = new Set(events.map((e) => e.event_type));
    for (const required of [
      "table_read",
      "value_committed",
      "record_opened",
      "record_updated",
      "copy_semantic",
      "paste_semantic",
      "table_exported",
    ]) {
      expect(types.has(required as never), `missing ${required}`).toBe(true);
    }
  });
});

describe("unrelatedFixture", () => {
  const events = unrelatedFixture();

  it("is schema-valid and deterministic", () => {
    for (const e of events) expect(workflowEventSchema.parse(e)).toBeTruthy();
    expect(unrelatedFixture()).toEqual(events);
  });

  it("has no repeated step signature (nothing to cluster)", () => {
    const signatures = events.map((e) => `${e.app.display_name}:${e.event_type}`);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});
