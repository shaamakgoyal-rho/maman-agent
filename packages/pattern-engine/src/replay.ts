/**
 * Replay verification (the trust-through-proof loop).
 *
 * Given a compiled candidate agent's step signature (the pattern's canonical
 * sequence) and the worker's own recorded runs (episode traces), replay the
 * agent's proposed action sequence against each recorded run and score it:
 * match / partial (with the first divergent step) / miss.
 *
 * Everything here is pure and deterministic. Traces are LOCAL-ONLY replay-
 * fidelity data — they are read from the device store and never synced; the
 * verification numbers (tested/matched) are the only thing that surfaces.
 *
 * Alignment model (deliberately simple, documented, and tested):
 * - Steps compare on the (target_role, semantic_type, object_type) tuple of
 *   the canonical token — timing and counts are ignored by construction.
 * - COMPARISON-BASIS DEGRADATION: the live AX observer emits neither
 *   semantic_type nor object_type, so on the primary source every token ends
 *   ":-:-". Requiring the semantic tuple there filtered BOTH sides of every
 *   comparison to zero and parked every live pattern in `insufficient_evidence`
 *   forever. When semantic and object are both "-" but a role or event_type is
 *   present, steps fall back to comparing on (target_role, event_type) — a
 *   coarser but real basis. This degrades the COMPARISON, never the gates:
 *   the honesty refusals below (zero-step, self-referential, thresholds) are
 *   untouched.
 * - "No-op" steps (role, semantic AND object all absent — app activations and
 *   navigation noise) are skippable on both sides, so harmless reordering of
 *   no-ops never fails a run.
 * - The agent's meaningful steps must appear in order in the trace: match =
 *   every step aligned; partial = a real prefix aligned before diverging
 *   (reported with the first divergent step); miss = diverged immediately.
 */

/**
 * `insufficient_evidence` is NOT a soft pass. It is the verdict when there was
 * nothing meaningful to compare — an agent sequence with no executable steps,
 * or a trace with none. It exists because the alternative was catastrophic:
 * the filter below removes steps carrying neither semantic_type nor
 * object_type, and on the first real device EVERY observed token was of that
 * shape, so `agentSteps` came out empty, the alignment loop never ran, and the
 * function returned `{verdict: "match", aligned_steps: 0}` for every trace —
 * including an unrelated trace and an empty one. A live pattern was reported
 * to the user as "tested against your last 21 runs and matched 21" and shown
 * a "verified" badge on the strength of 21 comparisons of nothing.
 */
export type ReplayVerdict = "match" | "partial" | "miss" | "insufficient_evidence";

export type ReplayRunResult = {
  episode_id: string;
  started_at: string;
  verdict: ReplayVerdict;
  /** Steps of the agent sequence aligned before divergence (= length on match). */
  aligned_steps: number;
  /**
   * Executable steps the agent sequence actually asserted for this comparison.
   * A match with `expected_steps === 0` is a contradiction and cannot be
   * produced; the invariant is asserted in replay.test.ts.
   */
  expected_steps: number;
  /** Present when verdict !== "match": the 1-based agent step that diverged. */
  divergence_step?: number;
  /** Human-readable expected/observed at the divergence, card-ready. */
  expected?: string;
  observed?: string;
  /** Present on `insufficient_evidence`: what was missing, in plain language. */
  insufficiency_reason?: string;
};

/** How the tested runs were separated from the runs that produced the sequence. */
export type ValidationMethod =
  /** Sequence derived from the same runs it was tested on — proves nothing. */
  | "self_referential"
  /** Each run tested against a sequence derived from the OTHER runs. */
  | "leave_one_out"
  /** Sequence derived from older runs, tested on newer held-out runs. */
  | "holdout";

export type ReplayReport = {
  runs_tested: number;
  runs_matched: number;
  results: ReplayRunResult[];
  /** How independence was obtained. Surfaced to the user, not implied. */
  validation_method: ValidationMethod;
  /** Runs excluded because there was nothing meaningful to compare. */
  runs_insufficient: number;
  /** Meaningful expected steps in the projected agent (0 ⇒ nothing verifiable). */
  meaningful_expected_steps: number;
};

export type EpisodeTrace = {
  episode_id: string;
  started_at: string;
  tokens: string[];
};

/** Canonical token → the comparison tuple (event_type, target_role, semantic_type, object_type). */
function tupleOf(token: string): {
  eventType: string;
  role: string;
  semantic: string;
  object: string;
} {
  const parts = token.split(":");
  return {
    eventType: parts[2] ?? "-",
    role: parts[3] ?? "-",
    semantic: parts[4] ?? "-",
    object: parts[5] ?? "-",
  };
}

/**
 * The comparison key for one step. Semantic tokens compare on
 * (role, semantic, object); tokens with no semantic fields — every live AX
 * token today — fall back to (role, event_type). The two bases are prefixed
 * so a semantic step can never accidentally equal a fallback step.
 */
function comparisonKey(token: string): string {
  const t = tupleOf(token);
  if (t.semantic === "-" && t.object === "-") {
    return `f|${t.role}|${t.eventType}`;
  }
  return `s|${t.role}|${t.semantic}|${t.object}`;
}

function sameStep(a: string, b: string): boolean {
  return comparisonKey(a) === comparisonKey(b);
}

/**
 * A true no-op: role, semantic AND object all absent (pure app_activated /
 * navigation noise). A role-bearing token with no semantics is NOT a no-op —
 * it is comparable on the fallback basis and counts as a meaningful step.
 */
function isNoOp(token: string): boolean {
  const t = tupleOf(token);
  return t.role === "-" && t.semantic === "-" && t.object === "-";
}

const APP_WORDS: Record<string, string> = {
  crm: "your CRM",
  spreadsheet: "your spreadsheet",
  email: "email",
  browser: "the browser",
  files: "your files",
  calendar: "your calendar",
  chat: "chat",
};

/** Card-ready plain language for a canonical token ("update a record in your CRM"). */
export function humanizeToken(token: string): string {
  const parts = token.split(":");
  const category = parts[1] ?? "-";
  const eventType = parts[2] ?? "-";
  const semantic = parts[4] ?? "-";
  const object = parts[5] ?? "-";
  const app = APP_WORDS[category] ?? (category === "-" ? "an app" : category);
  const action =
    semantic !== "-"
      ? semantic.replace(/_/g, " ")
      : eventType !== "-"
        ? eventType.replace(/_/g, " ")
        : "a step";
  const target = object !== "-" ? ` on ${object.replace(/_/g, " ")} records` : "";
  return `${action}${target} in ${app}`;
}

/** Replays one agent step sequence against one recorded run. */
export function replayAgainstTrace(agentSequence: string[], trace: EpisodeTrace): ReplayRunResult {
  const agentSteps = agentSequence.filter((t) => !isNoOp(t));
  const traceSteps = trace.tokens.filter((t) => !isNoOp(t));

  // FAIL CLOSED ON NOTHING TO COMPARE. This guard is the whole point of the
  // `insufficient_evidence` verdict: without it, an empty `agentSteps` skipped
  // the loop below and fell through to `verdict: "match"`, so a pattern whose
  // every token lacked semantic_type and object_type "matched" any trace at
  // all. Both sides must carry at least one executable step for a comparison
  // to mean anything.
  if (agentSteps.length === 0 || traceSteps.length === 0) {
    return {
      episode_id: trace.episode_id,
      started_at: trace.started_at,
      verdict: "insufficient_evidence",
      aligned_steps: 0,
      expected_steps: agentSteps.length,
      insufficiency_reason:
        agentSteps.length === 0
          ? "the helper has no executable steps to check — nothing about this workflow was specific enough to replay"
          : "this run recorded no executable steps to check against",
    };
  }

  let ti = 0;
  let aligned = 0;
  for (let ai = 0; ai < agentSteps.length; ai++) {
    // The agent's next step must appear in the trace at or after the cursor.
    let found = -1;
    for (let j = ti; j < traceSteps.length; j++) {
      if (sameStep(agentSteps[ai]!, traceSteps[j]!)) {
        found = j;
        break;
      }
    }
    if (found === -1) {
      const divergenceStep = ai + 1;
      const base = {
        episode_id: trace.episode_id,
        started_at: trace.started_at,
        aligned_steps: aligned,
        expected_steps: agentSteps.length,
        divergence_step: divergenceStep,
        expected: humanizeToken(agentSteps[ai]!),
        ...(traceSteps[ti] !== undefined ? { observed: humanizeToken(traceSteps[ti]!) } : {}),
      };
      return aligned === 0 ? { ...base, verdict: "miss" } : { ...base, verdict: "partial" };
    }
    ti = found + 1;
    aligned += 1;
  }
  return {
    episode_id: trace.episode_id,
    started_at: trace.started_at,
    verdict: "match",
    aligned_steps: aligned,
    expected_steps: agentSteps.length,
  };
}

function reportFrom(
  results: ReplayRunResult[],
  method: ValidationMethod,
  meaningfulExpectedSteps: number,
): ReplayReport {
  return {
    runs_tested: results.length,
    runs_matched: results.filter((r) => r.verdict === "match").length,
    runs_insufficient: results.filter((r) => r.verdict === "insufficient_evidence").length,
    results,
    validation_method: method,
    meaningful_expected_steps: meaningfulExpectedSteps,
  };
}

/**
 * Replays a FIXED agent sequence against the K most recent recorded runs.
 *
 * `validation_method` is reported as `self_referential` because this function
 * cannot know where the sequence came from, and in the existing call path it
 * came from the medoid of these same traces — so a high score here is close to
 * a tautology. Prefer `replayCandidateLeaveOneOut` for anything user-facing;
 * this remains for callers holding an independently-derived sequence (e.g. a
 * projected AgentSpec) and for the holdout helper below.
 */
export function replayCandidate(
  agentSequence: string[],
  traces: EpisodeTrace[],
  window: number,
  method: ValidationMethod = "self_referential",
): ReplayReport {
  const recentFirst = [...traces].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const tested = recentFirst.slice(0, Math.max(0, window));
  const meaningful = agentSequence.filter((t) => !isNoOp(t)).length;
  const results = tested.map((t) => replayAgainstTrace(agentSequence, t));
  return reportFrom(results, method, meaningful);
}

/**
 * INDEPENDENT validation: for each held-out run, derive the expected sequence
 * from the OTHER runs and replay it against the held-out one.
 *
 * This is the fix for "verifying a candidate by comparing its canonical
 * sequence against the same episodes that produced that sequence". Under the
 * old self-referential scheme the medoid trivially matched its own source
 * episodes, so the score measured nothing but internal consistency.
 *
 * `deriveSequence` receives the training subset and returns the sequence to
 * test (the caller supplies the same medoid/representative logic the engine
 * uses, or a compiled-and-projected AgentSpec's step signature).
 *
 * Fewer than 2 runs cannot be split into train and test, so the result is
 * reported as insufficient rather than as a pass.
 */
export function replayCandidateLeaveOneOut(
  traces: EpisodeTrace[],
  deriveSequence: (training: EpisodeTrace[]) => string[],
  window: number,
): ReplayReport {
  const recentFirst = [...traces].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const tested = recentFirst.slice(0, Math.max(0, window));

  if (tested.length < 2) {
    return reportFrom(
      tested.map((t) => ({
        episode_id: t.episode_id,
        started_at: t.started_at,
        verdict: "insufficient_evidence" as const,
        aligned_steps: 0,
        expected_steps: 0,
        insufficiency_reason:
          "only one recorded run — there is no second run to check the helper against",
      })),
      "leave_one_out",
      0,
    );
  }

  let meaningfulTotal = 0;
  const results = tested.map((heldOut) => {
    const training = tested.filter((t) => t.episode_id !== heldOut.episode_id);
    const sequence = deriveSequence(training);
    meaningfulTotal = Math.max(meaningfulTotal, sequence.filter((t) => !isNoOp(t)).length);
    return replayAgainstTrace(sequence, heldOut);
  });
  return reportFrom(results, "leave_one_out", meaningfulTotal);
}

/** Thresholds a report must clear before anything may be called "verified". */
export type VerificationGate = {
  min_runs: number;
  min_match_pct: number;
};

export type VerificationOutcome = {
  verified: boolean;
  /** Plain-language reason when not verified — never a bare false. */
  reason?: string;
};

/**
 * THE badge gate. Every condition is required, and each exists because its
 * absence produced a false "verified" claim in practice:
 *
 * 1. at least one meaningful executable step (the zero-step vacuous match);
 * 2. a nonzero number of aligned steps somewhere (nothing actually lined up);
 * 3. independent validation — a self-referential report can never verify;
 * 4. enough runs, and enough of them matching, per the configured gate;
 * 5. no unresolved required capability or input (passed in by the caller,
 *    which owns runtime/connector knowledge this pure module must not guess).
 */
export function evaluateVerification(
  report: ReplayReport,
  gate: VerificationGate,
  readiness: { unresolved_capabilities?: string[]; missing_inputs?: string[] } = {},
): VerificationOutcome {
  if (report.meaningful_expected_steps === 0) {
    return {
      verified: false,
      reason:
        "nothing about this workflow is specific enough to check yet — no executable steps were learned",
    };
  }
  if (report.validation_method === "self_referential") {
    return {
      verified: false,
      reason: "checked only against the runs it was learned from, which proves nothing on its own",
    };
  }
  const usable = report.runs_tested - report.runs_insufficient;
  if (usable < gate.min_runs) {
    return {
      verified: false,
      reason: `${usable} usable run${usable === 1 ? "" : "s"} to check against; needs ${gate.min_runs}`,
    };
  }
  if (!report.results.some((r) => r.aligned_steps > 0)) {
    return { verified: false, reason: "no step of the helper lined up with any recorded run" };
  }
  const ratio = usable > 0 ? report.runs_matched / usable : 0;
  if (ratio < gate.min_match_pct) {
    return {
      verified: false,
      reason: `matched ${report.runs_matched} of ${usable} runs; needs ${Math.round(gate.min_match_pct * 100)}%`,
    };
  }
  const unresolved = readiness.unresolved_capabilities ?? [];
  if (unresolved.length > 0) {
    return { verified: false, reason: `needs a capability that isn't available: ${unresolved[0]}` };
  }
  const missing = readiness.missing_inputs ?? [];
  if (missing.length > 0) {
    return { verified: false, reason: `needs information it doesn't have yet: ${missing[0]}` };
  }
  return { verified: true };
}
