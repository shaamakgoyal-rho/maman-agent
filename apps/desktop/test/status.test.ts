import { describe, expect, it } from "vitest";
import { dotFor, statusLine, type ObservationHealth } from "../src/lib/status.js";

/**
 * The status bar must never overstate health or activity: green only when the
 * observer is genuinely observing, and no pipeline text while observation is
 * paused or broken.
 */

const OBSERVING: ObservationHealth = { observer: "observing", paused: false };

describe("dotFor (honest health)", () => {
  it("is green ONLY when observing and not paused", () => {
    expect(dotFor(OBSERVING)).toBe("green");
    expect(dotFor({ observer: "observing", paused: true })).toBe("gray");
    expect(dotFor({ observer: "starting", paused: false })).toBe("amber");
    expect(dotFor({ observer: "disabled", paused: false })).toBe("gray");
    expect(dotFor({ observer: "failed", paused: false })).toBe("red");
    expect(dotFor({ observer: "permission_required", paused: false })).toBe("red");
    expect(dotFor({ observer: "unknown_future_state", paused: false })).toBe("gray");
  });
});

describe("statusLine", () => {
  it("names the exact workflow in every pipeline beat", () => {
    const title = "PO / invoice / receipt match";
    expect(statusLine({ kind: "watching", title, detail: "5 of 8 checks" }, OBSERVING).text).toBe(
      "Watching: PO / invoice / receipt match — 5 of 8 checks",
    );
    expect(statusLine({ kind: "creating_agent", title }, OBSERVING).text).toBe(
      "Creating agent: PO / invoice / receipt match…",
    );
    expect(statusLine({ kind: "agent_ready", title }, OBSERVING).text).toBe(
      "Agent drafted: PO / invoice / receipt match",
    );
    expect(statusLine({ kind: "approval_needed", title }, OBSERVING).text).toBe(
      "PO / invoice / receipt match: waiting for your approval",
    );
    expect(
      statusLine({ kind: "run_done", title, summary: "applied 4 approved changes" }, OBSERVING)
        .text,
    ).toBe("PO / invoice / receipt match: applied 4 approved changes");
  });

  it("creation and run beats are sticky; funnel beats are not", () => {
    expect(statusLine({ kind: "creating_agent", title: "X" }, OBSERVING).sticky).toBe(true);
    expect(statusLine({ kind: "approval_needed", title: "X" }, OBSERVING).sticky).toBe(true);
    expect(statusLine({ kind: "watching", title: "X", detail: "d" }, OBSERVING).sticky).toBe(false);
    expect(statusLine({ kind: "idle" }, OBSERVING).sticky).toBe(false);
  });

  it("a paused or broken observer outranks every pipeline beat", () => {
    const paused = statusLine(
      { kind: "creating_agent", title: "X" },
      { observer: "observing", paused: true },
    );
    expect(paused.dot).toBe("gray");
    expect(paused.text).toBe("Observation is paused");
    const failed = statusLine(
      { kind: "watching", title: "X", detail: "d" },
      { observer: "failed", paused: false },
    );
    expect(failed.dot).toBe("red");
    expect(failed.text).toBe("Maman needs attention");
  });

  it("idle under a healthy observer says exactly that", () => {
    const line = statusLine({ kind: "idle" }, OBSERVING);
    expect(line).toEqual({ dot: "green", text: "Maman is observing", sticky: false });
  });
});
