import { create } from "zustand";
import {
  browserAdapters,
  compileAgentSpec,
  demoAdapterRegistry,
  DemoSalesforceWorld,
  executeStep,
  intentFittingSteps,
  observedSemantics,
  requireAdapter,
  resolveIntentOnSurface,
  RuntimeCapabilityError,
  runtimeFromRegistry,
  validateRuntimeCapabilities,
  validateAgentInputs,
  AgentInputError,
  DEMO_ACCOUNT_LIST,
  DISCOVERED_FIELDS_INPUT,
  FIELD_VALUES_INPUT,
  type CapabilityContext,
  type ProposedDiff,
  type RunState,
} from "@maman/agent-runtime";
import {
  DEFAULT_ORG_POLICY,
  evaluatePackPolicy,
  type PackPolicyVerdict,
} from "@maman/policy-engine";
import { SHIPPED_PACKS } from "@maman/domain-packs";
import { DemoModelProvider } from "@maman/model-provider";
import { computeReceiptRoi } from "@maman/roi-engine";
import {
  describeIntentPlanSteps,
  describeQuestion,
  outstandingQuestions,
} from "@maman/intent-layer";
import {
  looksLikeSecret,
  petReceiptSummary,
  uuidv7,
  type AgentSpec,
  type ExecutionReceipt,
  type PatternCandidate,
} from "@maman/contracts";
import { emitAppEvent } from "./bridge.js";
import type { StatusBeat } from "./status.js";
import { tauriAgentBrowserHost } from "./agentBrowser.js";
import {
  mintAuthorization,
  previewBrowserPlan,
  runBrowserPlan,
  revertBrowserRun,
  changesForRecord,
  type BrowserLaneResult,
  type BrowserPlanPreview,
} from "./browserRun.js";

/**
 * Desktop-local run executor (Journeys E & F). Drives the SAME pure run engine
 * and demo adapters the Temporal worker uses, with a real approval gate — so
 * the product loop is fully usable in the desktop app without a running
 * Temporal server. Production runs go through the durable worker (proven by
 * apps/worker integration tests); this shares the identical safety semantics:
 * shadow never writes, writes are diff-hash-bound and idempotent, and every
 * run produces an immutable receipt.
 */

export type RunPhase =
  | "idle"
  /**
   * The agent looked at the page, resolved everything it could, and needs an
   * answer only a person has. Distinct from `failed` on purpose: nothing went
   * wrong, and the run continues the moment the question is answered.
   */
  | "needs_input"
  | "running_read"
  | "preparing_diff"
  | "waiting_approval"
  | "applying_write"
  | "verifying"
  | "completed"
  | "completed_with_warnings"
  | "cancelled"
  | "failed";

export type PendingApproval = { step_id: string; diff: ProposedDiff; diff_sha256: string };

/**
 * One thing the agent could not find out by looking, put to the user.
 *
 * Only slots the intent layer marks `needs_you_to_supply_it` become questions.
 * A gap the agent could close itself — a page it has not opened yet, a field it
 * failed to match — is not the user's to answer, and asking would move work
 * onto them that the agent is supposed to do.
 */
export type RunQuestion = {
  /** Slot name, used to key the answer back into resolution. */
  slot: string;
  /** The label above the box: "What should “Phone” say?" */
  prompt: string;
  /** The fuller explanation, for when the short question is not enough. */
  detail: string;
};

/**
 * Which lane the write will actually use.
 *
 * `api` is the demo/connector path and is preferred — `capability-router` scores it
 * above the browser. `browser` is for systems with no usable API, and it is the
 * user's decision to take it, not an automatic fallback from a failed API write:
 * a consequential step that fails stops and asks.
 */
export type RunLane = "api" | "browser";

/**
 * The exact actions a browser-lane run will perform, shown BEFORE approval.
 *
 * A diff summary ("update 4 fields") is not something anyone can consent to
 * meaningfully when the mechanism is a real browser typing into a real page. These
 * are the per-step lines the user reads instead.
 */
export type BrowserPlanView = {
  lines: string[];
  writes: number;
  record: string;
  /** Changes on records other than the one open in the browser. */
  deferred: number;
  deferred_records: string[];
};

/**
 * A run blocked by DOMAIN POLICY (L3) before anything executed. Distinct from
 * an approval: an approval is a gate the worker can pass, while a policy hold
 * means this agent may not perform the step at all (segregation of duties) or
 * needs a second approver (dual control). Policy is evaluated BEFORE the run
 * starts and before any autonomy consideration — it can only restrict.
 */
export type PolicyHold = {
  kind: "segregation_of_duties" | "dual_control";
  /** Worker-facing explanations straight from the pack rules. */
  reasons: string[];
  /** The strictest autonomy ceiling policy imposed, if any. */
  ceiling?: string;
};

type RunsStore = {
  phase: RunPhase;
  mode: "shadow" | "supervised";
  lane: RunLane;
  diff: ProposedDiff | null;
  pending: PendingApproval | null;
  /** The plan the user is approving, when the lane is the browser. */
  browserPlan: BrowserPlanView | null;
  /** Why a browser plan could not be built, named down to the change. */
  browserPlanRefusal: string | null;
  /** Set after a browser run applied something that could be put back. */
  revertable: BrowserLaneResult["revertable"];
  /** Set when domain policy blocked the run before execution. */
  policyHold: PolicyHold | null;
  /**
   * What the agent needs answered before it can run, with the plan it would
   * carry out once answered — so the user is agreeing to something specific,
   * not filling in a box for an unnamed purpose.
   */
  questions: RunQuestion[];
  questionPlan: string[];
  /**
   * Set when a run used bundled sample data because the real input could not
   * be supplied here. Shown next to the result, because a diff computed from a
   * sample is not a statement about the user's own records.
   */
  sampleDataNotice: string | null;
  receipt: ExecutionReceipt | null;
  receiptSummary: string | null;
  error: string | null;
  /** Origins actuation may touch, from the user's allowlist. Never hardcoded. */
  browserOrigins: string[];
  /**
   * Chooses the lane for the next supervised run. `origins` comes from the
   * settings allowlist: with none, a browser write has nothing to be checked
   * against and the plan is refused rather than sent.
   */
  setLane: (lane: RunLane, origins?: readonly string[]) => void;
  /** Undoes an applied browser run. Consequential, so it re-approves. */
  revert: () => Promise<void>;
  startShadow: (
    candidate: PatternCandidate,
    generalizedIntent?: string,
    desiredOutcome?: string,
    agentName?: string,
  ) => Promise<void>;
  startSupervised: (
    candidate: PatternCandidate,
    generalizedIntent?: string,
    desiredOutcome?: string,
    agentName?: string,
  ) => Promise<void>;
  approve: () => Promise<void>;
  reject: () => Promise<void>;
  /** Supplies what only the user could answer, then runs again from the top. */
  answer: (answers: Record<string, string>) => Promise<void>;
  reset: () => void;
};

const OWNER = "00000000-0000-7000-8000-000000000001";
const ORG = "00000000-0000-7000-8000-000000000002";

/**
 * The in-app executor. Named so a capability-availability refusal can say WHERE
 * the adapter is missing — "the local demo runtime has no adapter for
 * browser.supervised_form_fill" is actionable; a bare TypeError is not.
 */
const LOCAL_RUNTIME_ID = "local-demo";

const DEFAULT_INTENT = "reconcile_account_list";
const DEFAULT_OUTCOME = "Reconcile the account list with Salesforce.";

async function compile(
  candidate: PatternCandidate,
  generalizedIntent: string,
  desiredOutcome: string,
): Promise<AgentSpec> {
  const result = await compileAgentSpec({
    candidate,
    generalized_intent: generalizedIntent,
    desired_outcome: desiredOutcome,
    organization_id: ORG,
    owner_user_id: OWNER,
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date(),
    model: new DemoModelProvider(),
    // Compile FOR the runtime that will actually execute — the SAME registry,
    // built the same way. Probing a demo-only registry here while running a
    // wider one would refuse browser steps the runtime can now perform; probing
    // a wider one than runs would do the reverse and crash mid-run.
    runtime: runtimeFromRegistry(
      LOCAL_RUNTIME_ID,
      registryFor(demoWorld(), useRuns.getState().browserOrigins),
    ),
  });
  if (result.status !== "valid") throw new Error(result.message);
  return result.spec;
}

// The demo world persists across runs for the whole session (like a real
// backend): an approved write stays visible to the next run's reads, so the
// demo arc shows real state change instead of a world reset per run.
let activeWorld: DemoSalesforceWorld | null = null;

/**
 * Is the user actually at the machine, watching?
 *
 * A consequential browser write requires presence, and the pure actuator
 * refuses the write when this is false — so a hardcoded `true` would REMOVE the
 * check rather than satisfy it. Panel visibility is the strongest signal this
 * process genuinely has: the panel is where approvals happen, and a hidden or
 * backgrounded panel means the person is not looking at what the agent is doing.
 *
 * It is not proof of a human (a screen can be left on). It is honest evidence,
 * and it fails CLOSED — in a non-browser context with no document, it is false.
 */
export function userIsPresent(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible";
}

/**
 * The adapters for one run: the demo Salesforce world PLUS the real browser
 * adapters, once the user has named at least one origin.
 *
 * These are different capability ids, so nothing falls back between them — a
 * browser step cannot be served by a demo adapter, and a Salesforce step cannot
 * be served by the browser. With no origins configured the browser adapters are
 * absent entirely, which makes `validateRuntimeCapabilities` refuse a browser
 * plan up front instead of failing part-way through a run.
 */
export function registryFor(world: DemoSalesforceWorld, origins: readonly string[]) {
  const registry = demoAdapterRegistry(world);
  if (origins.length === 0) return registry;
  for (const [id, adapter] of browserAdapters({
    host: tauriAgentBrowserHost(origins),
    allowedOrigins: origins,
    userPresent: userIsPresent,
    // Org policy for supervised browser writes. The local runtime has no org
    // policy service, so this mirrors the same default the compiler applies;
    // the actuator still requires approval and presence on top of it.
    allowSupervisedBrowserWrites: true,
    newRequestId: () => uuidv7(),
    mintAuthorization: mintAuthorization,
  })) {
    registry.set(id, adapter);
  }
  return registry;
}

/** Test seam: the exact registry a run would use for these origins. */
export function __testRegistryFor(origins: readonly string[]) {
  return registryFor(new DemoSalesforceWorld(), origins);
}

const demoWorld = (): DemoSalesforceWorld => (activeWorld ??= new DemoSalesforceWorld());
// A run's spec + state persist between shadow/approve calls.
let activeSpec: AgentSpec | null = null;
let activeState: RunState | null = null;
/**
 * What discovery resolved for this run, held across the approval gate.
 *
 * Not recomputed after approval, for the same reason the browser plan is not:
 * the user approved a diff against a specific control, and re-resolving could
 * land on a different one.
 */
let activeInputs: Record<string, unknown> = {};
let activeRunId = "";

/**
 * MEASUREMENTS TAKEN FROM THE RUN, not decided in advance.
 *
 * The receipt used to state `started_at: Date.now() - 2000`, `duration_ms: 100`
 * per step, `duration_ms: 2000` in totals, `records_read: 10`, and
 * `provider_cost_usd: 0.08` — every one a literal, none of them observed. The
 * receipt is the audit record; a number in it that nothing measured is an
 * assertion about a run that did not happen that way.
 */
let runStartedAtMs = 0;
/** step_id → wall-clock ms that step actually took. */
let stepDurations = new Map<string, number>();
/** step_id → records the step actually read, where the output could be counted. */
let stepRecordsRead = new Map<string, number>();
/**
 * The observed pattern this run came from.
 *
 * Its `median_duration_ms` and `occurrence_count` are REAL — derived from the
 * episodes the pattern engine clustered. The receipt's ROI baseline used to be
 * `11 * 60_000` with `baseline_observation_count: 6`, both invented, and since
 * 6 clears `MEASURED_BASELINE_MIN_OBSERVATIONS` the provenance system stamped
 * the resulting savings "measured". The mechanism was working; it was being
 * lied to.
 */
let activeCandidate: PatternCandidate | null = null;

/** Resets every measurement so a new run cannot inherit the last one's numbers. */
function beginMeasuring(candidate: PatternCandidate): void {
  runStartedAtMs = Date.now();
  stepDurations = new Map();
  stepRecordsRead = new Map();
  activeCandidate = candidate;
}

/**
 * How many records a read step returned, when that is answerable.
 *
 * Returns undefined rather than 0 for an output whose shape carries no count.
 * Zero is a measurement; "I could not tell" is not, and reporting the second as
 * the first is how `records_read: 10` felt reasonable in the first place.
 */
function countRecords(output: unknown): number | undefined {
  if (Array.isArray(output)) return output.length;
  if (typeof output === "object" && output !== null) {
    const values = (output as { values?: unknown }).values;
    if (values && typeof values === "object") return Object.keys(values).length;
    const matches = (output as { matches?: unknown }).matches;
    if (Array.isArray(matches)) return matches.length;
  }
  return undefined;
}

/**
 * Times one step.
 *
 * `performance.now()` rather than `Date.now()`: the demo adapters finish in
 * well under a millisecond, and a wall-clock difference would round every one
 * of them to 0 — indistinguishable from a step that never ran. The rounded
 * value can still be 0 for a genuinely instant step, which is why
 * `stepDurations.has()` is what tells the receipt whether a step executed at
 * all, rather than the value being non-zero.
 */
async function measured<T>(stepId: string, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    stepDurations.set(stepId, Math.round(performance.now() - startedAt));
  }
}
let interventionStart = 0;
// The running agent's workflow name, for the status bar.
let activeAgentName = "your helper";

async function beat(beatValue: StatusBeat): Promise<void> {
  await emitAppEvent({ type: "status_beat", beat: beatValue });
}

/**
 * Evaluates domain policy for the agent's observed actions BEFORE the run.
 *
 * The SoD case is exactly "this agent would perform two conflicting actions":
 * every observed action is passed as a sibling, so a workflow containing both
 * code_invoice and approve_invoice trips the rule regardless of which
 * capabilities the compiler picked.
 */
function evaluateRunPolicy(candidate: PatternCandidate): {
  hold: PolicyHold | null;
  verdicts: PackPolicyVerdict[];
} {
  const actions = candidate.domain_actions ?? [];
  if (actions.length === 0) return { hold: null, verdicts: [] };

  const verdicts = actions.map((action, index) =>
    evaluatePackPolicy(
      SHIPPED_PACKS,
      { step_id: `a${index}`, domain_action: action },
      {
        sibling_actions: actions.filter((a) => a !== action),
      },
    ),
  );

  const blocking = verdicts.find((v) => v.requires_human) ?? verdicts.find((v) => v.dual_control);
  if (!blocking) return { hold: null, verdicts };

  const ceiling = verdicts.map((v) => v.ceiling).find((c) => c !== undefined);
  return {
    hold: {
      kind: blocking.requires_human ? "segregation_of_duties" : "dual_control",
      reasons: [...new Set(verdicts.flatMap((v) => v.reasons.map((r) => r.message)))],
      ...(ceiling ? { ceiling } : {}),
    },
    verdicts,
  };
}

/** A read-only run proposes nothing; the receipt must say 0, not crash. */
const EMPTY_DIFF: ProposedDiff = {
  summary: {
    input_rows: 0,
    confident_matches: 0,
    ambiguous_skipped: 0,
    missing: 0,
    change_count: 0,
    accounts_affected: 0,
  },
  changes: [],
};

function buildReceipt(
  spec: AgentSpec,
  mode: "shadow" | "supervised",
  diff: ProposedDiff,
  writes: { completed: number; verified: boolean } | null,
  interventionMs: number,
  /**
   * The lane the write actually used. This was hardcoded to "api" before the
   * browser lane existed, which would have made every browser run's receipt claim
   * an API call it never made — the receipt is the audit record, so it reports
   * what happened rather than what was expected.
   */
  lane: RunLane = "api",
): ExecutionReceipt {
  const writeSource: ExecutionReceipt["steps"][number]["source"] =
    lane === "browser" ? "browser_extension" : "api";
  const completedAtMs = Date.now();
  // A run that somehow reached here without `beginMeasuring` gets an honest
  // zero rather than a plausible-looking elapsed time.
  const startedAtMs = runStartedAtMs > 0 ? runStartedAtMs : completedAtMs;

  const steps = spec.steps.map((s) => ({
    step_id: s.step_id,
    capability_id: s.capability_id,
    // Reads still come from the API/demo adapters in both lanes; only the write
    // step changes hands.
    source: s.mode === "write" ? writeSource : ("api" as const),
    // Only what was counted. A step whose output had no countable shape, or
    // that never ran, contributes 0 — and `totals.records_read` below is the
    // sum of these rather than a separate literal that could disagree.
    records_read: stepRecordsRead.get(s.step_id) ?? 0,
    writes_proposed: s.mode === "propose_write" ? diff.summary.change_count : 0,
    writes_completed: s.mode === "write" && writes ? writes.completed : 0,
    verification:
      s.mode === "write" && writes
        ? writes.verified
          ? ("independent_read_passed" as const)
          : ("independent_read_failed" as const)
        : ("none" as const),
    duration_ms: stepDurations.get(s.step_id) ?? 0,
    retries: 0,
  }));

  return {
    schema_version: 1,
    receipt_id: uuidv7(),
    run_id: activeRunId,
    agent_id: spec.agent_id,
    agent_version_id: spec.version_id,
    recipe_version: 1,
    trigger: "manual",
    mode,
    started_at: new Date(startedAtMs).toISOString(),
    completed_at: new Date(completedAtMs).toISOString(),
    steps,
    approvals: [],
    totals: {
      records_read: steps.reduce((sum, s) => sum + s.records_read, 0),
      writes_proposed: diff.summary.change_count,
      writes_completed: writes?.completed ?? 0,
      duration_ms: completedAtMs - startedAtMs,
      model_input_tokens: 0,
      model_output_tokens: 0,
      model_cost_usd: 0,
      // The local runtime bills nothing: the demo adapters make no provider
      // call, and the browser lane drives a page the user is already paying
      // for. `0.08` was a plausible-looking invention, and a fabricated cost is
      // worse than a zero because it survives into ROI as a real subtraction.
      provider_cost_usd: 0,
      total_cost_usd: 0,
    },
    roi: computeReceiptRoi({
      // THE BASELINE IS OBSERVED, not chosen. `median_duration_ms` and
      // `occurrence_count` come from the episodes the pattern engine actually
      // clustered. With no candidate in hand the baseline is 0 and the
      // observation count is 0, which drops provenance to "estimated" — the
      // honest answer, and the one the ROI engine was built to express.
      manual_baseline_ms: activeCandidate?.median_duration_ms ?? 0,
      baseline_observation_count: activeCandidate?.occurrence_count ?? 0,
      automated_human_ms: interventionMs,
      human_review_ms: interventionMs,
      mode,
    }),
    outcome:
      mode === "shadow"
        ? "completed"
        : writes && !writes.verified
          ? "completed_with_warnings"
          : "completed",
  };
}

function ctx(mode: "shadow" | "supervised"): CapabilityContext {
  return { run_id: activeRunId, organization_id: ORG, owner_user_id: OWNER, mode };
}

/**
 * The agent looks at the page and works out what it will act on — BEFORE the
 * first step runs.
 *
 * This is the run-time half of the intent layer. Until it existed, the browser
 * recipe compiled a spec whose first step asked for `fields` that nobody
 * supplied, so every browser agent failed on step one with "Teach the workflow
 * which fields matter first". The answer was never for the user to type field
 * names in; it was for the agent to go and look.
 *
 * Two properties make this safe to run before an approval:
 *
 * - It happens ONCE, up front. A run that started and then discovered it did
 *   not know which field to write would already have read the page and shown a
 *   proposal it cannot honour.
 * - It only LOOKS. Discovery lists the page's controls — names and roles, never
 *   values — and the write gate is untouched: the user still approves a diff,
 *   and the write still refuses if the field moved.
 */
/**
 * Answers the user has given for this run, by slot name.
 *
 * Held only for as long as the run needs them, and never written to disk. What
 * a person types here goes into a page, so it is treated as the transient thing
 * it is rather than as a saved setting they would have to remember to clear.
 */
let pendingAnswers: Record<string, string> = {};

/** Enough context to start the run again once the question is answered. */
type ResumeContext = {
  candidate: PatternCandidate;
  generalizedIntent: string;
  desiredOutcome: string;
  agentName: string | undefined;
  mode: "shadow" | "supervised";
};
let resumeContext: ResumeContext | null = null;

function rememberForResume(context: ResumeContext): void {
  resumeContext = context;
}

/**
 * What the user typed, checked before it can reach a page.
 *
 * A credential typed into this box would be written into a field, relayed over
 * the native channel, and recorded on the receipt — three places secret material
 * is never allowed. The contract would reject it at `set_value`, but that
 * arrives as an opaque mid-run refusal; catching it here says why, at the moment
 * they can do something about it.
 */
export function checkAnswer(value: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, reason: "This can't be empty." };
  if (trimmed.length > 512) return { ok: false, reason: "That's longer than a field can hold." };
  if (looksLikeSecret(trimmed)) {
    return {
      ok: false,
      reason: "That looks like a password or key. Maman never types secrets into pages.",
    };
  }
  return { ok: true };
}

/**
 * Binds the bundled sample list, when that is genuinely all this runtime has.
 *
 * The local runtime cannot read a file the user chose — there is no file
 * picker and no reader. Before, that gap was filled by `local.parse_csv`
 * ignoring its input and returning fixture rows whatever happened, so the run
 * silently reconciled sample data and reported ROI for it.
 *
 * Binding the sentinel HERE makes the same outcome an explicit choice: it lands
 * in the run's inputs, the adapter accepts it because it was asked for by name,
 * and `sampleDataNotice` tells the user which list they are looking at. A real
 * file path would be refused by the adapter rather than quietly answered.
 */
function bundledSampleFor(spec: AgentSpec): Record<string, unknown> {
  const wantsList = spec.inputs.some((i) => i.key === "account_csv" && i.required);
  if (!wantsList) return {};
  useRuns.setState({
    sampleDataNotice:
      "No account list was provided, so this run used Maman's bundled sample list — the numbers below describe that sample, not your data.",
  });
  return { account_csv: DEMO_ACCOUNT_LIST };
}

/**
 * Refuses a run whose spec declares inputs nothing supplied.
 *
 * The sibling of the capability check, and here for the same reason: a spec
 * that cannot be satisfied should never perform its first step. Before this,
 * `account_csv` was declared REQUIRED, the desktop passed nothing, and the
 * reconciliation run completed on bundled fixture rows and published a receipt
 * with ROI for an account list the user never provided.
 */
function requireInputs(spec: AgentSpec, inputs: Record<string, unknown>): void {
  const readiness = validateAgentInputs(spec, inputs);
  if (!readiness.ready) throw new AgentInputError(readiness);
}

type DiscoveryOutcome =
  | { ok: true; inputs: Record<string, unknown> }
  | { ok: false; questions: RunQuestion[]; plan: string[] };

async function discoverInputsFor(
  spec: AgentSpec,
  candidate: PatternCandidate,
  mode: "shadow" | "supervised",
  /**
   * What the user has already told this agent, by slot name. Only they can
   * answer these — a value to write is in a person's head, not on a page — so
   * an empty object means the run stops at the question rather than proceeding
   * with something invented.
   */
  supplied: Readonly<Record<string, string>> = {},
): Promise<DiscoveryOutcome> {
  const needed = spec.inputs.filter((i) => i.source === "discovered_on_surface");
  if (needed.length === 0) return { ok: true, inputs: bundledSampleFor(spec) };

  const intent = intentFittingSteps(candidate.canonical_sequence, spec.steps);
  if (!intent) {
    // The spec declares it needs discovery and no catalogued intent covers its
    // steps, so nothing can say what to look for. Refusing is the only honest
    // move; running would mean guessing a target.
    throw new Error(
      "This helper needs to find a field on the page, but I don't have a recipe that says which one to look for.",
    );
  }

  const origins = useRuns.getState().browserOrigins;
  const resolution = await resolveIntentOnSurface({
    intent,
    deps: {
      host: tauriAgentBrowserHost(origins),
      allowedOrigins: origins,
      userPresent: userIsPresent,
      // Discovery never writes, so the write policy is irrelevant to it and is
      // stated false rather than inherited — a look must not be the thing that
      // carries a write permission into the run.
      allowSupervisedBrowserWrites: false,
      newRequestId: () => uuidv7(),
      mintAuthorization,
    },
    ctx: ctx(mode),
    supplied,
    observedSemantics: observedSemantics(candidate.canonical_sequence),
  });

  if (resolution.status === "could_not_look") {
    // Not a question: the user cannot answer "your browser window is not open"
    // by typing into a box. It is an error with a fix they perform elsewhere.
    throw new Error(resolution.message);
  }

  if (resolution.status === "needs_you") {
    const askable = outstandingQuestions(resolution.resolved);
    if (askable.length === 0) {
      // The gap is real but nothing in it is the user's to answer — a field the
      // agent looked for and could not match, say. Putting a box in front of
      // them would be moving the agent's job onto them.
      throw new Error(resolution.message);
    }
    return {
      ok: false,
      questions: askable.map((q) => ({
        slot: q.name,
        prompt: describeQuestion(resolution.resolved, q),
        detail: q.detail,
      })),
      // What answering would actually authorise. A box with no plan attached
      // asks someone to supply a value without telling them what it is for.
      plan: describeIntentPlanSteps(resolution.resolved),
    };
  }

  // The discovered control and the supplied value, joined only now that both
  // are known. Neither is guessed from the other: an agent with a field and no
  // value never reaches this line, because resolution refused above.
  const value = resolution.resolved.filled.find((f) => f.kind === "value");
  return {
    ok: true,
    inputs: {
      [DISCOVERED_FIELDS_INPUT]: resolution.fields,
      ...(value
        ? { [FIELD_VALUES_INPUT]: resolution.fields.map((f) => ({ ...f, value: value.value })) }
        : {}),
    },
  };
}

/**
 * The plan compiled at the approval gate, held until the user approves.
 *
 * Deliberately NOT recomputed in `approve`: the user approves a specific list of
 * actions, and rebuilding it afterwards would mean they consented to one plan and
 * a different one ran. Staleness is handled instead by each write carrying the
 * value it expects to find, so a page that moved on refuses rather than overwrites.
 */
let activeBrowserPlan: BrowserPlanPreview | null = null;

export const useRuns = create<RunsStore>((set) => ({
  phase: "idle",
  mode: "shadow",
  lane: "api",
  browserOrigins: [],
  diff: null,
  pending: null,
  browserPlan: null,
  browserPlanRefusal: null,
  revertable: [],
  policyHold: null,
  questions: [],
  questionPlan: [],
  sampleDataNotice: null,
  receipt: null,
  receiptSummary: null,
  error: null,

  startShadow: async (
    candidate,
    generalizedIntent = DEFAULT_INTENT,
    desiredOutcome = DEFAULT_OUTCOME,
    agentName,
  ) => {
    activeAgentName = agentName ?? "your helper";
    set({
      phase: "running_read",
      mode: "shadow",
      diff: null,
      // Cleared on every start: a question left on screen from the last attempt
      // would sit above a run that has moved past it.
      questions: [],
      questionPlan: [],
      sampleDataNotice: null,
      receipt: null,
      error: null,
    });
    await emitAppEvent({ type: "simulate_pet_event", event: "RUN_STARTED" });
    await beat({ kind: "running", title: activeAgentName, phase: "reading" });
    try {
      activeWorld = demoWorld();
      activeSpec = await compile(candidate, generalizedIntent, desiredOutcome);
      activeState = { outputs: {} };
      activeRunId = uuidv7();
      beginMeasuring(candidate);
      const registry = registryFor(activeWorld, useRuns.getState().browserOrigins);
      // BLOCK BEFORE EXECUTING ANYTHING. Checking here rather than per-step
      // means a spec that is missing an adapter for a LATER step never performs
      // its earlier steps — a half-run that stops at a TypeError is worse than
      // a refusal, because the user cannot tell what did and did not happen.
      const readiness = validateRuntimeCapabilities(
        activeSpec,
        runtimeFromRegistry(LOCAL_RUNTIME_ID, registry),
      );
      if (!readiness.ready) throw new RuntimeCapabilityError(readiness);
      // Look at the page and resolve the target BEFORE the first step, for the
      // same reason the capability check is here: a run that gets part-way and
      // then finds it does not know what to act on is worse than one that never
      // started.
      const discovery = await discoverInputsFor(activeSpec, candidate, "shadow", pendingAnswers);
      if (!discovery.ok) {
        rememberForResume({
          candidate,
          generalizedIntent,
          desiredOutcome,
          agentName,
          mode: "shadow",
        });
        set({ phase: "needs_input", questions: discovery.questions, questionPlan: discovery.plan });
        return;
      }
      activeInputs = discovery.inputs;
      requireInputs(activeSpec, activeInputs);
      let diff: ProposedDiff | null = null;
      for (const step of activeSpec.steps) {
        if (step.mode === "write") continue; // shadow: stop before writes
        set({ phase: step.mode === "propose_write" ? "preparing_diff" : "running_read" });
        const result = await measured(step.step_id, () =>
          executeStep({
            spec: activeSpec!,
            step,
            state: activeState!,
            agentInputs: activeInputs,
            ctx: ctx("shadow"),
            adapter: requireAdapter(registry, step, LOCAL_RUNTIME_ID),
          }),
        );
        if (result.kind === "read") {
          const counted = countRecords(result.output);
          if (counted !== undefined) stepRecordsRead.set(step.step_id, counted);
        }
        if (result.kind === "proposed") diff = result.diff;
      }
      await emitAppEvent({ type: "simulate_pet_event", event: "REVIEW_STARTED" });
      const receipt = buildReceipt(activeSpec, "shadow", diff ?? EMPTY_DIFF, null, 0);
      await emitAppEvent({ type: "simulate_pet_event", event: "REVIEW_FINISHED" });
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_SUCCEEDED" });
      await beat({
        kind: "run_done",
        title: activeAgentName,
        summary: `proposed ${(diff ?? EMPTY_DIFF).summary.change_count} changes, wrote nothing`,
      });
      set({
        phase: "completed",
        diff: diff ?? EMPTY_DIFF,
        receipt,
        receiptSummary: petReceiptSummary(receipt),
      });
    } catch (e) {
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
      await beat({ kind: "run_failed", title: activeAgentName });
      set({ phase: "failed", error: e instanceof Error ? e.message : "run failed" });
    }
  },

  startSupervised: async (
    candidate,
    generalizedIntent = DEFAULT_INTENT,
    desiredOutcome = DEFAULT_OUTCOME,
    agentName,
  ) => {
    activeAgentName = agentName ?? "your helper";
    // DOMAIN POLICY FIRST: before any step runs, and before autonomy is
    // considered at all. A hold stops the run rather than gating it.
    const { hold } = evaluateRunPolicy(candidate);
    if (hold) {
      set({
        phase: "cancelled",
        mode: "supervised",
        diff: null,
        pending: null,
        policyHold: hold,
        receipt: null,
        error: null,
      });
      await beat({
        kind: "run_failed",
        title: agentName ?? "your helper",
      });
      return;
    }
    set({
      phase: "running_read",
      mode: "supervised",
      diff: null,
      pending: null,
      policyHold: null,
      questions: [],
      questionPlan: [],
      sampleDataNotice: null,
      receipt: null,
      error: null,
    });
    await emitAppEvent({ type: "simulate_pet_event", event: "RUN_STARTED" });
    await beat({ kind: "running", title: activeAgentName, phase: "reading" });
    try {
      activeWorld = demoWorld();
      activeSpec = await compile(candidate, generalizedIntent, desiredOutcome);
      activeState = { outputs: {} };
      activeRunId = uuidv7();
      beginMeasuring(candidate);
      const registry = registryFor(activeWorld, useRuns.getState().browserOrigins);
      const discovery = await discoverInputsFor(
        activeSpec,
        candidate,
        "supervised",
        pendingAnswers,
      );
      if (!discovery.ok) {
        rememberForResume({
          candidate,
          generalizedIntent,
          desiredOutcome,
          agentName,
          mode: "supervised",
        });
        set({ phase: "needs_input", questions: discovery.questions, questionPlan: discovery.plan });
        return;
      }
      activeInputs = discovery.inputs;
      requireInputs(activeSpec, activeInputs);
      let pending: PendingApproval | null = null;
      for (const step of activeSpec.steps) {
        if (step.mode === "write") break; // pause at the approval gate
        set({ phase: step.mode === "propose_write" ? "preparing_diff" : "running_read" });
        const result = await measured(step.step_id, () =>
          executeStep({
            spec: activeSpec!,
            step,
            state: activeState!,
            agentInputs: activeInputs,
            ctx: ctx("supervised"),
            adapter: requireAdapter(registry, step, LOCAL_RUNTIME_ID),
          }),
        );
        if (result.kind === "read") {
          const counted = countRecords(result.output);
          if (counted !== undefined) stepRecordsRead.set(step.step_id, counted);
        }
        if (result.kind === "proposed") {
          pending = {
            step_id: "apply-updates",
            diff: result.diff,
            diff_sha256: result.diff_sha256,
          };
        }
      }
      if (!pending) {
        // Nothing to approve: the agent is read-only. Complete honestly as a
        // supervised run that changed nothing rather than crash or fake a gate.
        const receipt = buildReceipt(activeSpec, "shadow", EMPTY_DIFF, null, 0);
        await emitAppEvent({ type: "simulate_pet_event", event: "RUN_SUCCEEDED" });
        await beat({
          kind: "run_done",
          title: activeAgentName,
          summary: "read-only run — nothing to approve, nothing changed",
        });
        set({
          phase: "completed",
          diff: EMPTY_DIFF,
          receipt,
          receiptSummary: petReceiptSummary(receipt),
        });
        return;
      }
      // BROWSER LANE: compile the plan NOW, so the approval the user gives is for
      // the actions they read. A plan that cannot be built blocks the gate with the
      // reason rather than presenting an approval that would fail on arrival.
      activeBrowserPlan = null;
      let browserPlan: BrowserPlanView | null = null;
      let browserPlanRefusal: string | null = null;
      if (useRuns.getState().lane === "browser") {
        const planned =
          useRuns.getState().browserOrigins.length === 0
            ? {
                ok: false as const,
                reason:
                  "no allow-listed origin for browser actuation — add the site in Settings first",
              }
            : previewBrowserPlan(pending.diff);
        if (planned.ok) {
          activeBrowserPlan = planned.preview;
          browserPlan = {
            lines: planned.preview.lines,
            writes: planned.preview.writes,
            record: planned.preview.record,
            deferred: planned.preview.deferred,
            deferred_records: planned.preview.deferred_records,
          };
        } else {
          browserPlanRefusal = planned.reason;
        }
      }

      interventionStart = Date.now();
      await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_REQUIRED" });
      await beat({ kind: "approval_needed", title: activeAgentName });
      set({
        phase: "waiting_approval",
        diff: pending.diff,
        pending,
        browserPlan,
        browserPlanRefusal,
      });
    } catch (e) {
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
      await beat({ kind: "run_failed", title: activeAgentName });
      set({ phase: "failed", error: e instanceof Error ? e.message : "run failed" });
    }
  },

  setLane: (lane, origins) =>
    set({
      lane,
      browserPlan: null,
      browserPlanRefusal: null,
      ...(origins === undefined ? {} : { browserOrigins: [...origins] }),
    }),

  revert: async () => {
    const { revertable, lane } = useRuns.getState();
    if (lane !== "browser" || revertable.length === 0) return;
    set({ phase: "applying_write" });
    try {
      // A revert is a consequential write and goes through the same gate. The
      // approval is the user pressing Revert; presence is implied by that, and
      // policy still has to allow browser writes at all.
      const result = await revertBrowserRun(revertable, {
        runId: activeRunId,
        routedSource: "browser_extension",
        mode: "supervised",
        allowSupervisedBrowserWrites: true,
        approvalGranted: true,
        userPresent: true,
        allowedOrigins: useRuns.getState().browserOrigins,
      });
      if (!result.ok) {
        set({ phase: "completed_with_warnings", error: `could not revert: ${result.reason}` });
        return;
      }
      const clean = result.outcome.halted_at === null && result.outcome.all_writes_verified;
      await beat({
        kind: "run_done",
        title: activeAgentName,
        summary: clean
          ? `put back ${result.outcome.writes_applied} changes`
          : `revert stopped: ${result.outcome.halted_because ?? "unverified"}`,
      });
      set({
        phase: clean ? "completed" : "completed_with_warnings",
        revertable: clean ? [] : revertable,
        ...(clean ? {} : { error: result.outcome.halted_because ?? "revert unverified" }),
      });
    } catch (e) {
      set({
        phase: "completed_with_warnings",
        error: e instanceof Error ? e.message : "revert failed",
      });
    }
  },

  approve: async () => {
    if (!activeSpec || !activeWorld || !activeState) return;
    const pending = useRuns.getState().pending;
    if (!pending) return;
    await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_RESOLVED" });
    set({ phase: "applying_write", pending: null });

    // BROWSER LANE. Not a fallback from a failed API write — the lane was chosen
    // before the run, and the plan was approved as read.
    if (useRuns.getState().lane === "browser") {
      if (activeBrowserPlan === null) {
        set({ phase: "failed", error: "no approved browser plan" });
        return;
      }
      try {
        const scoped = changesForRecord(pending.diff, activeBrowserPlan.record);
        const result = await runBrowserPlan(activeBrowserPlan, scoped.changes, {
          runId: activeRunId,
          routedSource: "browser_extension",
          mode: "supervised",
          allowSupervisedBrowserWrites: true,
          approvalGranted: true,
          userPresent: true,
          allowedOrigins: useRuns.getState().browserOrigins,
        });
        set({ phase: "verifying" });
        const interventionMs = Date.now() - interventionStart;
        const writes = {
          completed: result.outcome.writes_applied,
          verified: result.outcome.all_writes_verified && result.outcome.halted_at === null,
        };

        // A HALTED RUN THAT APPLIED NOTHING IS A FAILURE, not a warning.
        //
        // Found by running it: with no relay connected, every step failed, yet the
        // run reported "finished a read-only run, saved approximately 10 minutes"
        // and counted toward earned autonomy. Zero writes made the receipt look
        // read-only, and `completed_with_warnings` counts as a completed approved
        // run. Nothing was written, nothing was saved, and nothing was earned.
        if (result.outcome.halted_at !== null && writes.completed === 0) {
          await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
          await beat({ kind: "run_failed", title: activeAgentName });
          set({
            phase: "failed",
            revertable: [],
            error: result.outcome.halted_because ?? "the browser did not perform the plan",
          });
          return;
        }

        const receipt = buildReceipt(
          activeSpec,
          "supervised",
          pending.diff,
          writes,
          interventionMs,
          "browser",
        );
        const deferredNote =
          activeBrowserPlan.deferred > 0
            ? `; ${activeBrowserPlan.deferred} left on other records`
            : "";
        await emitAppEvent({
          type: "simulate_pet_event",
          event: writes.verified ? "RUN_SUCCEEDED" : "RUN_FAILED",
        });
        await beat(
          writes.verified
            ? {
                kind: "run_done",
                title: activeAgentName,
                summary: `applied ${writes.completed} changes in the browser${deferredNote}`,
              }
            : { kind: "run_failed", title: activeAgentName },
        );
        set({
          phase: writes.verified ? "completed" : "completed_with_warnings",
          receipt,
          receiptSummary: petReceiptSummary(receipt),
          revertable: result.revertable,
          // The halt reason is shown verbatim: "the browser refused:
          // precondition_failed" tells the user their page changed under the plan,
          // which a generic failure would not.
          ...(result.outcome.halted_because === null
            ? {}
            : { error: result.outcome.halted_because }),
        });
      } catch (e) {
        await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
        await beat({ kind: "run_failed", title: activeAgentName });
        set({ phase: "failed", error: e instanceof Error ? e.message : "browser write failed" });
      }
      return;
    }

    try {
      const registry = registryFor(activeWorld, useRuns.getState().browserOrigins);
      const writeStep = activeSpec.steps.find((s) => s.mode === "write")!;
      const result = await measured(writeStep.step_id, () =>
        executeStep({
          spec: activeSpec!,
          step: writeStep,
          state: activeState!,
          // The SAME inputs the read and propose steps ran with. Re-discovering
          // here could resolve a different control than the one the user was
          // shown a diff for, which is the one thing an approval gate must not
          // allow.
          agentInputs: activeInputs,
          ctx: ctx("supervised"),
          adapter: requireAdapter(registry, writeStep, LOCAL_RUNTIME_ID),
          approvedDiff: pending!.diff,
          approvedDiffSha: pending!.diff_sha256,
        }),
      );
      set({ phase: "verifying" });
      const interventionMs = Date.now() - interventionStart;
      const writes =
        result.kind === "written"
          ? { completed: pending.diff.summary.change_count, verified: result.verified }
          : { completed: 0, verified: false };
      const receipt = buildReceipt(activeSpec, "supervised", pending.diff, writes, interventionMs);
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_SUCCEEDED" });
      await beat({
        kind: "run_done",
        title: activeAgentName,
        summary: `applied ${writes.completed} approved changes`,
      });
      set({
        phase: writes.verified ? "completed" : "completed_with_warnings",
        receipt,
        receiptSummary: petReceiptSummary(receipt),
      });
    } catch (e) {
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
      await beat({ kind: "run_failed", title: activeAgentName });
      set({ phase: "failed", error: e instanceof Error ? e.message : "write failed" });
    }
  },

  reject: async () => {
    await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_RESOLVED" });
    set({ phase: "cancelled", pending: null });
  },

  /**
   * Takes the user's answers and starts the run again from the top.
   *
   * A full restart rather than a resume, deliberately. Nothing was written —
   * discovery only looks — so there is no partial state to reconcile, and
   * re-running discovery re-reads the page, which is right: it may have changed
   * while the box was open, and acting on the surface as it was when the
   * question appeared is how a stale target gets written to.
   */
  answer: async (answers) => {
    const context = resumeContext;
    if (!context) return;
    for (const [slot, value] of Object.entries(answers)) {
      const check = checkAnswer(value);
      if (!check.ok) {
        // Refused before it can reach a page, and before the run restarts.
        set({ phase: "needs_input", error: check.reason });
        return;
      }
      pendingAnswers[slot] = value.trim();
    }
    set({ error: null });
    const { candidate, generalizedIntent, desiredOutcome, agentName, mode } = context;
    if (mode === "shadow") {
      await useRuns.getState().startShadow(candidate, generalizedIntent, desiredOutcome, agentName);
    } else {
      await useRuns
        .getState()
        .startSupervised(candidate, generalizedIntent, desiredOutcome, agentName);
    }
  },

  reset: () => {
    activeBrowserPlan = null;
    // The answers go with the run they were given for. Carrying them into the
    // next one would write a value the user supplied for something else.
    pendingAnswers = {};
    resumeContext = null;
    set({
      phase: "idle",
      diff: null,
      pending: null,
      browserPlan: null,
      browserPlanRefusal: null,
      revertable: [],
      policyHold: null,
      questions: [],
      questionPlan: [],
      sampleDataNotice: null,
      receipt: null,
      receiptSummary: null,
      error: null,
    });
  },
}));
