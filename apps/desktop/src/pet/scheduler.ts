import {
  ANIMATIONS,
  SLEEP_FRAME,
  SLOW_IDLE_DURATIONS,
  TRANSIENT_CYCLES,
  mamanAnimationMap,
  type AnimationName,
  type MamanAnimationState,
} from "./atlas.js";

/**
 * Deterministic TypeScript frame scheduler (no CSS keyframes).
 * Every frame carries its own duration; transitions are testable with fake
 * timers. Exactly one plan runs at a time — `play` always cancels the
 * previous timer chain before starting a new one.
 */

export type Frame = { row: number; column: number; duration: number };

export type PlayPlan =
  | { kind: "static"; frame: { row: number; column: number } }
  | { kind: "loop"; frames: Frame[] }
  | { kind: "transient"; frames: Frame[]; cycles: number; then: Frame[] };

export function framesFor(name: AnimationName, durations?: number[]): Frame[] {
  const def = ANIMATIONS[name];
  const d = durations ?? def.durations;
  return Array.from({ length: def.frames }, (_, i) => ({
    row: def.row,
    column: i,
    duration: d[i] ?? d[d.length - 1] ?? 150,
  }));
}

/** Quiet idle: row-zero timing multiplied by six. */
export function slowIdleFrames(): Frame[] {
  return framesFor("idle", SLOW_IDLE_DURATIONS);
}

/**
 * Gentle deterministic look-around scan for the `looking_around` state:
 * a few directions from rows 9–10 interleaved with calm idle holds.
 */
export const LOOK_AROUND_SEQUENCE: Frame[] = [
  { row: ANIMATIONS["look-a"].row, column: 2, duration: 1200 }, // 45° up-right
  { row: 0, column: 0, duration: 900 },
  { row: ANIMATIONS["look-b"].row, column: 6, duration: 1200 }, // 315° up-left
  { row: 0, column: 0, duration: 900 },
  { row: ANIMATIONS["look-a"].row, column: 4, duration: 1000 }, // 90° right
  { row: 0, column: 5, duration: 1400 },
  { row: ANIMATIONS["look-b"].row, column: 4, duration: 1000 }, // 270° left
  { row: 0, column: 0, duration: 1600 },
];

/** Builds the playback plan for a product pet state. */
export function planForState(state: MamanAnimationState, reducedMotion: boolean): PlayPlan {
  const mapped = mamanAnimationMap[state];

  if (mapped === "idle-sleep-frame") {
    return { kind: "static", frame: SLEEP_FRAME };
  }

  if (reducedMotion) {
    // Reduced motion: only the first frame of the requested animation.
    if (mapped === "look-direction") {
      return { kind: "static", frame: { row: ANIMATIONS["look-a"].row, column: 0 } };
    }
    const def = ANIMATIONS[mapped];
    return { kind: "static", frame: { row: def.row, column: 0 } };
  }

  if (mapped === "idle") {
    return { kind: "loop", frames: slowIdleFrames() };
  }
  if (mapped === "look-direction") {
    return { kind: "loop", frames: LOOK_AROUND_SEQUENCE };
  }
  if (mapped === "running-left" || mapped === "running-right") {
    // Movement is positional feedback: loop while the pet is visibly moving;
    // the state ends when movement stops (drag settles).
    return { kind: "loop", frames: framesFor(mapped) };
  }
  if (mapped === "waving") {
    // A SUGGESTION BEACON, not a one-shot. The machine holds `waving` until
    // the suggestion is handled, but the transient plan played ~2s once and
    // settled into idle forever — after which the pet was indistinguishable
    // from having nothing to say. Loop a wave burst separated by one quiet
    // slow-idle cycle: recurring and noticeable, never frantic. Frame
    // timings are the locked atlas timings; only the sequence is composed.
    const burst = Array.from({ length: TRANSIENT_CYCLES }, () => framesFor(mapped)).flat();
    return { kind: "loop", frames: [...burst, ...slowIdleFrames()] };
  }
  // Every other animation is transient: play three complete cycles, then
  // settle into the quiet slow-idle loop until another state is requested.
  return {
    kind: "transient",
    frames: framesFor(mapped),
    cycles: TRANSIENT_CYCLES,
    then: slowIdleFrames(),
  };
}

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
};

export class FrameScheduler {
  private timer: unknown = null;
  private queue: Frame[] = [];
  private index = 0;
  private loopStart = 0;
  private paused = false;
  /** Playback-rate multiplier (Pet Lab control); 1 = authored speed. */
  speed = 1;
  current: { row: number; column: number } | null = null;

  constructor(
    private readonly onFrame: (frame: { row: number; column: number }) => void,
    private readonly timers: Timers = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
  ) {}

  /** Starts a plan. Always cancels the previous one first (single scheduler). */
  play(plan: PlayPlan): void {
    this.cancel();
    this.paused = false;
    if (plan.kind === "static") {
      this.queue = [];
      this.emit(plan.frame.row, plan.frame.column);
      return;
    }
    if (plan.kind === "loop") {
      this.queue = plan.frames;
      this.loopStart = 0;
    } else {
      const body: Frame[] = [];
      for (let c = 0; c < plan.cycles; c++) body.push(...plan.frames);
      this.queue = [...body, ...plan.then];
      this.loopStart = body.length;
    }
    this.index = 0;
    this.step();
  }

  private emit(row: number, column: number): void {
    this.current = { row, column };
    this.onFrame(this.current);
  }

  private step(): void {
    if (this.paused || this.queue.length === 0) return;
    const frame = this.queue[this.index]!;
    this.emit(frame.row, frame.column);
    this.timer = this.timers.set(() => {
      this.index += 1;
      if (this.index >= this.queue.length) this.index = this.loopStart;
      this.step();
    }, frame.duration / this.speed);
  }

  pause(): void {
    this.paused = true;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.step();
  }

  restart(): void {
    if (this.queue.length === 0) return;
    this.pause();
    this.index = 0;
    this.paused = false;
    this.step();
  }

  /** Cancels all timers. Safe to call repeatedly. */
  cancel(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.index = 0;
    this.paused = false;
  }
}
