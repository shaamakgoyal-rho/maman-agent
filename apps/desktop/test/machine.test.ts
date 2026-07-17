import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";
import {
  initialConditions,
  petMachine,
  PET_STATE_PRIORITY,
  resolvePetState,
  type PetConditions,
  type PetEvent,
  type PetStateName,
} from "../src/pet/machine.js";

function actorAt(events: PetEvent[] = []) {
  const actor = createActor(petMachine);
  actor.start();
  for (const e of events) actor.send(e);
  return actor;
}

function state(actor: ReturnType<typeof actorAt>): PetStateName {
  return actor.getSnapshot().value as PetStateName;
}

describe("resolvePetState priority", () => {
  const allOn: PetConditions = {
    observationPaused: true,
    privateContext: true,
    observing: true,
    thinking: true,
    suggestionAvailable: true,
    approvalPending: true,
    running: true,
    reviewing: true,
  };

  it("waiting beats working, reviewing, thinking, waving, sleeping", () => {
    expect(resolvePetState(allOn)).toBe("waiting");
  });

  it("working beats reviewing and below", () => {
    expect(resolvePetState({ ...allOn, approvalPending: false })).toBe("working");
  });

  it("reviewing beats thinking and below", () => {
    expect(resolvePetState({ ...allOn, approvalPending: false, running: false })).toBe("reviewing");
  });

  it("thinking beats waving and below", () => {
    expect(
      resolvePetState({ ...allOn, approvalPending: false, running: false, reviewing: false }),
    ).toBe("thinking");
  });

  it("waving beats sleeping and below", () => {
    expect(
      resolvePetState({
        ...allOn,
        approvalPending: false,
        running: false,
        reviewing: false,
        thinking: false,
      }),
    ).toBe("waving");
  });

  it("sleeping beats looking_around and idle", () => {
    expect(
      resolvePetState({
        ...initialConditions,
        observationPaused: true,
        observing: true,
      }),
    ).toBe("sleeping");
  });

  it("looking_around beats idle", () => {
    expect(
      resolvePetState({ ...initialConditions, observationPaused: false, observing: true }),
    ).toBe("looking_around");
  });

  it("idle when nothing is active", () => {
    expect(resolvePetState({ ...initialConditions, observationPaused: false })).toBe("idle");
  });

  it("priority list is the locked ordering", () => {
    expect(PET_STATE_PRIORITY).toEqual([
      "failed",
      "waiting",
      "working",
      "reviewing",
      "thinking",
      "waving",
      "sleeping",
      "looking_around",
      "idle",
    ]);
  });
});

describe("pet machine transitions", () => {
  it("starts sleeping: observation defaults off until consent", () => {
    expect(state(actorAt())).toBe("sleeping");
  });

  it("resumes to idle after consent", () => {
    expect(state(actorAt([{ type: "OBSERVATION_RESUMED" }]))).toBe("idle");
  });

  it("enters looking_around while observing", () => {
    expect(state(actorAt([{ type: "OBSERVATION_RESUMED" }, { type: "OBSERVING_STARTED" }]))).toBe(
      "looking_around",
    );
  });

  it("private context forces sleeping even while observing", () => {
    expect(
      state(
        actorAt([
          { type: "OBSERVATION_RESUMED" },
          { type: "OBSERVING_STARTED" },
          { type: "PRIVATE_CONTEXT_ENTERED" },
        ]),
      ),
    ).toBe("sleeping");
  });

  it("waves when a suggestion is ready, returns after handling", () => {
    const actor = actorAt([{ type: "OBSERVATION_RESUMED" }, { type: "SUGGESTION_READY" }]);
    expect(state(actor)).toBe("waving");
    actor.send({ type: "SUGGESTION_HANDLED" });
    expect(state(actor)).toBe("idle");
  });

  it("waiting (approval) interrupts working", () => {
    const actor = actorAt([{ type: "OBSERVATION_RESUMED" }, { type: "RUN_STARTED" }]);
    expect(state(actor)).toBe("working");
    actor.send({ type: "APPROVAL_REQUIRED" });
    expect(state(actor)).toBe("waiting");
    actor.send({ type: "APPROVAL_RESOLVED" });
    expect(state(actor)).toBe("working");
  });

  it("only one state renders at a time (snapshot value is a single string)", () => {
    const actor = actorAt([
      { type: "OBSERVATION_RESUMED" },
      { type: "OBSERVING_STARTED" },
      { type: "THINKING_STARTED" },
      { type: "SUGGESTION_READY" },
    ]);
    expect(typeof actor.getSnapshot().value).toBe("string");
    expect(state(actor)).toBe("thinking");
  });

  it("success displays then auto-resolves within four seconds", () => {
    vi.useFakeTimers();
    const actor = actorAt([
      { type: "OBSERVATION_RESUMED" },
      { type: "RUN_STARTED" },
      { type: "RUN_SUCCEEDED" },
    ]);
    expect(state(actor)).toBe("success");
    vi.advanceTimersByTime(4_000);
    expect(state(actor)).toBe("idle");
    vi.useRealTimers();
  });

  it("failed displays until acknowledged", () => {
    const actor = actorAt([
      { type: "OBSERVATION_RESUMED" },
      { type: "RUN_STARTED" },
      { type: "RUN_FAILED" },
    ]);
    expect(state(actor)).toBe("failed");
    // Lower-priority events do not dislodge failed.
    actor.send({ type: "SUGGESTION_READY" });
    expect(state(actor)).toBe("failed");
    actor.send({ type: "FAILURE_ACKNOWLEDGED" });
    expect(state(actor)).toBe("waving"); // suggestion queued during failure now shows
  });

  it("failed auto-resolves after ten seconds without acknowledgement", () => {
    vi.useFakeTimers();
    const actor = actorAt([
      { type: "OBSERVATION_RESUMED" },
      { type: "RUN_STARTED" },
      { type: "RUN_FAILED" },
    ]);
    expect(state(actor)).toBe("failed");
    vi.advanceTimersByTime(9_999);
    expect(state(actor)).toBe("failed");
    vi.advanceTimersByTime(1);
    expect(state(actor)).toBe("idle");
    vi.useRealTimers();
  });

  it("a new run interrupts the success display", () => {
    const actor = actorAt([
      { type: "OBSERVATION_RESUMED" },
      { type: "RUN_STARTED" },
      { type: "RUN_SUCCEEDED" },
    ]);
    expect(state(actor)).toBe("success");
    actor.send({ type: "RUN_STARTED" });
    expect(state(actor)).toBe("working");
  });

  it("a failure interrupts the success display", () => {
    const actor = actorAt([
      { type: "OBSERVATION_RESUMED" },
      { type: "RUN_STARTED" },
      { type: "RUN_SUCCEEDED" },
      { type: "RUN_FAILED" },
    ]);
    expect(state(actor)).toBe("failed");
  });

  it("reviewing shows after a run while ROI is calculated", () => {
    const actor = actorAt([{ type: "OBSERVATION_RESUMED" }, { type: "REVIEW_STARTED" }]);
    expect(state(actor)).toBe("reviewing");
    actor.send({ type: "REVIEW_FINISHED" });
    expect(state(actor)).toBe("idle");
  });

  it("pausing observation mid-flow returns to sleeping once higher priorities clear", () => {
    const actor = actorAt([
      { type: "OBSERVATION_RESUMED" },
      { type: "OBSERVING_STARTED" },
      { type: "THINKING_STARTED" },
      { type: "OBSERVATION_PAUSED" },
    ]);
    // thinking outranks sleeping
    expect(state(actor)).toBe("thinking");
    actor.send({ type: "THINKING_FINISHED" });
    expect(state(actor)).toBe("sleeping");
  });

  it("transition log hook receives state names without payloads", () => {
    const seen: string[] = [];
    const actor = createActor(petMachine);
    actor.subscribe((snapshot) => {
      seen.push(snapshot.value as string);
    });
    actor.start();
    actor.send({ type: "OBSERVATION_RESUMED" });
    actor.send({ type: "OBSERVING_STARTED" });
    expect(seen).toContain("sleeping");
    expect(seen[seen.length - 1]).toBe("looking_around");
    // Log entries are plain state names — nothing private to leak.
    for (const entry of seen) expect(typeof entry).toBe("string");
  });
});
