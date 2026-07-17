import { assign, setup } from "xstate";

/**
 * Pet state machine (locked spec §5).
 *
 * States:  sleeping | idle | looking_around | thinking | waving | waiting |
 *          working | reviewing | success | failed
 *
 * Priority (highest wins; only one state renders):
 *   failed > waiting > working > reviewing > thinking > waving
 *          > sleeping > looking_around > idle
 *
 * The machine tracks condition flags in context; every event updates flags and
 * the machine re-resolves to the highest-priority state. `success` and `failed`
 * are transient display states with timed exits (4s / 10s or acknowledgement).
 * Transitions are logged WITHOUT private payloads via the `onTransition` hook
 * the caller attaches to the actor.
 */

export type PetStateName =
  | "sleeping"
  | "idle"
  | "looking_around"
  | "thinking"
  | "waving"
  | "waiting"
  | "working"
  | "reviewing"
  | "success"
  | "failed";

export type PetConditions = {
  /** Observation paused by the user, or the current context is private. */
  observationPaused: boolean;
  privateContext: boolean;
  /** Observation actively collecting (allowlisted app in focus). */
  observing: boolean;
  /** Local pattern analysis or agent compilation in flight. */
  thinking: boolean;
  /** One new suggestion available to surface. */
  suggestionAvailable: boolean;
  /** User approval or connector action required. */
  approvalPending: boolean;
  /** An agent run is executing. */
  running: boolean;
  /** Validating results / calculating ROI. */
  reviewing: boolean;
};

export type PetEvent =
  | { type: "OBSERVATION_RESUMED" }
  | { type: "OBSERVATION_PAUSED" }
  | { type: "PRIVATE_CONTEXT_ENTERED" }
  | { type: "PRIVATE_CONTEXT_LEFT" }
  | { type: "OBSERVING_STARTED" }
  | { type: "OBSERVING_STOPPED" }
  | { type: "THINKING_STARTED" }
  | { type: "THINKING_FINISHED" }
  | { type: "SUGGESTION_READY" }
  | { type: "SUGGESTION_HANDLED" }
  | { type: "APPROVAL_REQUIRED" }
  | { type: "APPROVAL_RESOLVED" }
  | { type: "RUN_STARTED" }
  | { type: "RUN_SUCCEEDED" }
  | { type: "RUN_FAILED" }
  | { type: "REVIEW_STARTED" }
  | { type: "REVIEW_FINISHED" }
  | { type: "FAILURE_ACKNOWLEDGED" };

export const initialConditions: PetConditions = {
  observationPaused: true, // observation defaults OFF until consent completes
  privateContext: false,
  observing: false,
  thinking: false,
  suggestionAvailable: false,
  approvalPending: false,
  running: false,
  reviewing: false,
};

/** Resolves condition flags to the single highest-priority visible state. */
export function resolvePetState(c: PetConditions): PetStateName {
  if (c.approvalPending) return "waiting";
  if (c.running) return "working";
  if (c.reviewing) return "reviewing";
  if (c.thinking) return "thinking";
  if (c.suggestionAvailable) return "waving";
  if (c.observationPaused || c.privateContext) return "sleeping";
  if (c.observing) return "looking_around";
  return "idle";
}

const conditionUpdates: Record<PetEvent["type"], Partial<PetConditions>> = {
  OBSERVATION_RESUMED: { observationPaused: false },
  OBSERVATION_PAUSED: { observationPaused: true },
  PRIVATE_CONTEXT_ENTERED: { privateContext: true },
  PRIVATE_CONTEXT_LEFT: { privateContext: false },
  OBSERVING_STARTED: { observing: true },
  OBSERVING_STOPPED: { observing: false },
  THINKING_STARTED: { thinking: true },
  THINKING_FINISHED: { thinking: false },
  SUGGESTION_READY: { suggestionAvailable: true },
  SUGGESTION_HANDLED: { suggestionAvailable: false },
  APPROVAL_REQUIRED: { approvalPending: true },
  APPROVAL_RESOLVED: { approvalPending: false },
  RUN_STARTED: { running: true },
  RUN_SUCCEEDED: { running: false },
  RUN_FAILED: { running: false },
  REVIEW_STARTED: { reviewing: true },
  REVIEW_FINISHED: { reviewing: false },
  FAILURE_ACKNOWLEDGED: {},
};

const SUCCESS_DISPLAY_MS = 4_000;
const FAILED_DISPLAY_MS = 10_000;

type Ctx = { conditions: PetConditions };

// Steady states are modeled through a single always-resolving `route` state:
// every condition-changing event applies its flag update and re-enters `route`,
// which immediately transitions to the highest-priority resolved state.
const machineSetup = setup({
  types: {
    context: {} as Ctx,
    events: {} as PetEvent,
  },
  actions: {
    applyEvent: assign(({ context, event }) => ({
      conditions: { ...context.conditions, ...conditionUpdates[event.type] },
    })),
  },
  guards: {
    isSleeping: ({ context }) => resolvePetState(context.conditions) === "sleeping",
    isLooking: ({ context }) => resolvePetState(context.conditions) === "looking_around",
    isThinking: ({ context }) => resolvePetState(context.conditions) === "thinking",
    isWaving: ({ context }) => resolvePetState(context.conditions) === "waving",
    isWaiting: ({ context }) => resolvePetState(context.conditions) === "waiting",
    isWorking: ({ context }) => resolvePetState(context.conditions) === "working",
    isReviewing: ({ context }) => resolvePetState(context.conditions) === "reviewing",
  },
  delays: {
    successDisplay: SUCCESS_DISPLAY_MS,
    failedDisplay: FAILED_DISPLAY_MS,
  },
});

export const petMachine = machineSetup.createMachine({
  id: "pet",
  context: { conditions: initialConditions },
  initial: "route",
  on: {
    // Terminal-outcome events are handled by specific states below; everything
    // else updates conditions and re-routes by priority.
    "*": { target: ".route", actions: "applyEvent" },
    RUN_SUCCEEDED: { target: ".success", actions: "applyEvent" },
    RUN_FAILED: { target: ".failed", actions: "applyEvent" },
  },
  states: {
    route: {
      always: [
        { target: "waiting", guard: "isWaiting" },
        { target: "working", guard: "isWorking" },
        { target: "reviewing", guard: "isReviewing" },
        { target: "thinking", guard: "isThinking" },
        { target: "waving", guard: "isWaving" },
        { target: "sleeping", guard: "isSleeping" },
        { target: "looking_around", guard: "isLooking" },
        { target: "idle" },
      ],
    },
    sleeping: {},
    idle: {},
    looking_around: {},
    thinking: {},
    waving: {},
    waiting: {},
    working: {},
    reviewing: {},
    success: {
      // Display for no more than four seconds, then re-resolve.
      after: { successDisplay: { target: "route" } },
      on: {
        // Any new condition-changing event still applies, but success keeps
        // displaying unless a higher-priority interrupt arrives.
        APPROVAL_REQUIRED: { target: "waiting", actions: "applyEvent" },
        RUN_FAILED: { target: "failed", actions: "applyEvent" },
        RUN_STARTED: { target: "working", actions: "applyEvent" },
        "*": { actions: "applyEvent" },
      },
    },
    failed: {
      // Display until acknowledged or for ten seconds. Highest priority:
      // nothing interrupts failed except acknowledgement or timeout.
      after: { failedDisplay: { target: "route" } },
      on: {
        FAILURE_ACKNOWLEDGED: { target: "route" },
        "*": { actions: "applyEvent" },
      },
    },
  },
});

export const PET_STATE_PRIORITY: PetStateName[] = [
  "failed",
  "waiting",
  "working",
  "reviewing",
  "thinking",
  "waving",
  "sleeping",
  "looking_around",
  "idle",
];
