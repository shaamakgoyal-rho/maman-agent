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
 * - "No-op" steps (navigation/focus noise: no semantic_type AND no object_type)
 *   are skippable on both sides, so harmless reordering of no-ops never fails
 *   a run.
 * - The agent's meaningful steps must appear in order in the trace: match =
 *   every step aligned; partial = a real prefix aligned before diverging
 *   (reported with the first divergent step); miss = diverged immediately.
 */

export type ReplayVerdict = "match" | "partial" | "miss";

export type ReplayRunResult = {
  episode_id: string;
  started_at: string;
  verdict: ReplayVerdict;
  /** Steps of the agent sequence aligned before divergence (= length on match). */
  aligned_steps: number;
  /** Present when verdict !== "match": the 1-based agent step that diverged. */
  divergence_step?: number;
  /** Human-readable expected/observed at the divergence, card-ready. */
  expected?: string;
  observed?: string;
};

export type ReplayReport = {
  runs_tested: number;
  runs_matched: number;
  results: ReplayRunResult[];
};

export type EpisodeTrace = {
  episode_id: string;
  started_at: string;
  tokens: string[];
};

/** Canonical token → the comparison tuple (target_role, semantic_type, object_type). */
function tupleOf(token: string): { role: string; semantic: string; object: string } {
  const parts = token.split(":");
  return {
    role: parts[3] ?? "-",
    semantic: parts[4] ?? "-",
    object: parts[5] ?? "-",
  };
}

function sameStep(a: string, b: string): boolean {
  const ta = tupleOf(a);
  const tb = tupleOf(b);
  return ta.role === tb.role && ta.semantic === tb.semantic && ta.object === tb.object;
}

/** Navigation/focus noise: nothing semantic to compare. Skippable on both sides. */
function isNoOp(token: string): boolean {
  const t = tupleOf(token);
  return t.semantic === "-" && t.object === "-";
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
  };
}

/**
 * Replays the candidate agent against the K most recent recorded runs.
 * `traces` should already be the runs of this pattern (the caller selects by
 * signature); ordering here is most-recent-first for the "last N runs" claim.
 */
export function replayCandidate(
  agentSequence: string[],
  traces: EpisodeTrace[],
  window: number,
): ReplayReport {
  const recentFirst = [...traces].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const tested = recentFirst.slice(0, Math.max(0, window));
  const results = tested.map((t) => replayAgainstTrace(agentSequence, t));
  return {
    runs_tested: results.length,
    runs_matched: results.filter((r) => r.verdict === "match").length,
    results,
  };
}
