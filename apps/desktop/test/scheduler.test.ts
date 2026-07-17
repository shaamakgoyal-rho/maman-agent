import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANIMATIONS, SLEEP_FRAME, SLOW_IDLE_DURATIONS } from "../src/pet/atlas.js";
import {
  FrameScheduler,
  framesFor,
  planForState,
  slowIdleFrames,
  LOOK_AROUND_SEQUENCE,
} from "../src/pet/scheduler.js";

type Emitted = { row: number; column: number };

function makeScheduler() {
  const frames: Emitted[] = [];
  const scheduler = new FrameScheduler((f) => frames.push({ ...f }));
  return { scheduler, frames };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("slow idle (acceptance 8)", () => {
  it("normal idle uses six-times-slower row-zero timing", () => {
    expect(SLOW_IDLE_DURATIONS).toEqual([1680, 660, 660, 840, 840, 1920]);
    expect(slowIdleFrames().map((f) => f.duration)).toEqual([1680, 660, 660, 840, 840, 1920]);
  });

  it("idle loops through all six frames on the slow cadence", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.play(planForState("idle", false));
    expect(frames).toEqual([{ row: 0, column: 0 }]);
    vi.advanceTimersByTime(1680);
    expect(frames.at(-1)).toEqual({ row: 0, column: 1 });
    vi.advanceTimersByTime(660 + 660 + 840 + 840 + 1920);
    // wrapped back to frame 0
    expect(frames.at(-1)).toEqual({ row: 0, column: 0 });
    scheduler.cancel();
  });
});

describe("transient playback (acceptance 9)", () => {
  it("plays a transient three complete cycles, then enters slow idle", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.play(planForState("waving", false));
    const cycleMs = 140 + 140 + 140 + 280;
    // run all three wave cycles
    vi.advanceTimersByTime(cycleMs * 3 - 1);
    const waveFrames = frames.filter((f) => f.row === ANIMATIONS.waving.row);
    expect(waveFrames.length).toBe(3 * 4);
    // next tick lands in slow idle
    vi.advanceTimersByTime(1);
    expect(frames.at(-1)).toEqual({ row: 0, column: 0 });
    // and slow idle keeps looping (never returns to the wave row)
    vi.advanceTimersByTime(20_000);
    expect(frames.slice(3 * 4).every((f) => f.row === 0)).toBe(true);
    scheduler.cancel();
  });

  it("success (jumping) settles into slow idle after three cycles", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.play(planForState("success", false));
    const cycleMs = 140 * 4 + 280;
    vi.advanceTimersByTime(cycleMs * 3);
    expect(frames.at(-1)!.row).toBe(0);
    scheduler.cancel();
  });
});

describe("timer cancellation (acceptance 10)", () => {
  it("state changes cancel previous timers — no interleaved frames", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.play(planForState("working", false));
    vi.advanceTimersByTime(250); // mid-working
    scheduler.play(planForState("failed", false));
    const countAtSwitch = frames.length;
    vi.advanceTimersByTime(5_000);
    // Every frame emitted after the switch belongs to failed (row 5) or its
    // trailing slow idle (row 0) — never the working row.
    const after = frames.slice(countAtSwitch);
    expect(after.some((f) => f.row === ANIMATIONS.working.row)).toBe(false);
    scheduler.cancel();
  });

  it("never runs two schedulers: play() always cancels first", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.play(planForState("waving", false));
    scheduler.play(planForState("waiting", false));
    scheduler.play(planForState("reviewing", false));
    // Each play() emits its first frame synchronously, then is cancelled by
    // the next; only the LAST plan may ever schedule timers.
    const countAfterPlays = frames.length;
    expect(countAfterPlays).toBe(3);
    vi.advanceTimersByTime(600);
    const timedFrames = frames.slice(countAfterPlays);
    expect(timedFrames.length).toBeGreaterThan(0);
    expect(new Set(timedFrames.map((f) => f.row))).toEqual(new Set([ANIMATIONS.reviewing.row]));
    scheduler.cancel();
  });
});

describe("reduced motion (acceptance 11)", () => {
  it("shows only the first frame of the requested animation", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.play(planForState("waving", true));
    expect(frames).toEqual([{ row: ANIMATIONS.waving.row, column: 0 }]);
    vi.advanceTimersByTime(60_000);
    expect(frames.length).toBe(1); // no timers scheduled at all
    scheduler.cancel();
  });

  it("sleeping holds the calmest closed-eye idle frame in both modes", () => {
    for (const reduced of [false, true]) {
      const plan = planForState("sleeping", reduced);
      expect(plan).toEqual({ kind: "static", frame: SLEEP_FRAME });
    }
    expect(SLEEP_FRAME).toEqual({ row: 0, column: 2 });
  });
});

describe("state mapping", () => {
  it("thinking maps to the waiting animation (quieter than working)", () => {
    const plan = planForState("thinking", false);
    expect(plan.kind).toBe("transient");
    if (plan.kind === "transient") expect(plan.frames[0]!.row).toBe(ANIMATIONS.waiting.row);
  });

  it("movement states loop the running rows", () => {
    const left = planForState("moving_left", false);
    const right = planForState("moving_right", false);
    expect(left.kind).toBe("loop");
    expect(right.kind).toBe("loop");
    if (left.kind === "loop") expect(left.frames[0]!.row).toBe(ANIMATIONS["running-left"].row);
    if (right.kind === "loop") expect(right.frames[0]!.row).toBe(ANIMATIONS["running-right"].row);
  });

  it("looking_around uses the look rows in a gentle scan", () => {
    const plan = planForState("looking_around", false);
    expect(plan.kind).toBe("loop");
    const lookRows = LOOK_AROUND_SEQUENCE.filter((f) => f.row >= 9).length;
    expect(lookRows).toBeGreaterThanOrEqual(4);
  });
});

describe("playback controls (Pet Lab)", () => {
  it("pause stops emission; resume continues from the same frame", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.play(planForState("working", false));
    vi.advanceTimersByTime(120);
    scheduler.pause();
    const n = frames.length;
    vi.advanceTimersByTime(10_000);
    expect(frames.length).toBe(n);
    scheduler.resume();
    vi.advanceTimersByTime(120);
    expect(frames.length).toBeGreaterThan(n);
    scheduler.cancel();
  });

  it("speed divides frame durations", () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.speed = 2;
    scheduler.play(planForState("working", false));
    vi.advanceTimersByTime(60); // 120ms frame at 2x = 60ms
    expect(frames.length).toBe(2);
    scheduler.cancel();
  });

  it("framesFor uses per-frame durations with fallback to the last", () => {
    const frames = framesFor("jumping");
    expect(frames.map((f) => f.duration)).toEqual([140, 140, 140, 140, 280]);
    expect(frames.every((f) => f.row === ANIMATIONS.jumping.row)).toBe(true);
  });
});
