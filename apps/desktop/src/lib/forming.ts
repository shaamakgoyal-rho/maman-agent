import { ELIGIBILITY, OPPORTUNITY_THRESHOLD } from "@maman/pattern-engine";
import type { PatternCandidate } from "@maman/contracts";

/**
 * Turns a still-forming pattern candidate into an honest, human-readable view
 * of how close it is to becoming a suggestion. Every gate maps 1:1 to the real
 * eligibility bar in the pattern engine (@maman/pattern-engine ELIGIBILITY /
 * OPPORTUNITY_THRESHOLD) — no invented criteria — so the "Forming" UI shows
 * exactly why a suggestion has or hasn't appeared yet. Pure + unit-tested.
 */

export type FormingGate = {
  key: string;
  /** Short human label, e.g. "Seen enough times". */
  label: string;
  met: boolean;
  /** Current-vs-needed detail, e.g. "2 of 3 times". */
  detail: string;
};

export type FormingProgress = {
  gates: FormingGate[];
  metCount: number;
  total: number;
  /** 0..1 fraction of gates met (drives the progress bar). */
  ratio: number;
  /** One honest sentence on the single most important thing still needed. */
  nextStep: string;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function patternGates(c: PatternCandidate): FormingProgress {
  const gates: FormingGate[] = [
    {
      key: "repeats",
      label: "Seen enough times",
      met: c.occurrence_count >= ELIGIBILITY.min_occurrences,
      detail: `${c.occurrence_count} of ${ELIGIBILITY.min_occurrences} times`,
    },
    {
      key: "days",
      label: "On enough separate days",
      met: c.distinct_day_count >= ELIGIBILITY.min_distinct_days,
      detail: `${c.distinct_day_count} of ${ELIGIBILITY.min_distinct_days} days`,
    },
    {
      key: "consistency",
      label: "Done the same way each time",
      met: c.similarity_mean >= ELIGIBILITY.min_similarity_mean,
      detail: `${pct(c.similarity_mean)} alike (need ${pct(ELIGIBILITY.min_similarity_mean)})`,
    },
    {
      key: "time",
      label: "Worth enough time to automate",
      met: c.projected_minutes_saved_weekly >= ELIGIBILITY.min_projected_minutes_weekly,
      detail: `~${Math.round(c.projected_minutes_saved_weekly)} min/wk (need ${ELIGIBILITY.min_projected_minutes_weekly})`,
    },
    {
      key: "feasibility",
      label: "Safe steps a helper can do",
      met: c.feasibility_score >= ELIGIBILITY.min_feasibility,
      detail: c.feasibility_score >= ELIGIBILITY.min_feasibility ? "yes" : "not yet",
    },
    {
      key: "risk",
      label: "Low enough risk",
      met: c.risk_score <= ELIGIBILITY.max_risk,
      detail: c.risk_score <= ELIGIBILITY.max_risk ? "yes" : "too risky",
    },
    {
      key: "opportunity",
      label: "Clearly worth suggesting",
      met: c.opportunity_score >= OPPORTUNITY_THRESHOLD,
      detail: `${pct(c.opportunity_score)} (need ${pct(OPPORTUNITY_THRESHOLD)})`,
    },
  ];

  const metCount = gates.filter((g) => g.met).length;
  const total = gates.length;
  return {
    gates,
    metCount,
    total,
    ratio: total === 0 ? 0 : metCount / total,
    nextStep: nextStepFor(c, gates),
  };
}

/** The single most useful "here's what's left" sentence, in Maman's voice. */
function nextStepFor(c: PatternCandidate, gates: FormingGate[]): string {
  if (gates.every((g) => g.met)) {
    return "This is ready — I'll offer it as a suggestion next time you finish it.";
  }
  const repeats = gates.find((g) => g.key === "repeats")!;
  if (!repeats.met) {
    const left = ELIGIBILITY.min_occurrences - c.occurrence_count;
    return `I've seen this ${c.occurrence_count}×. ${left} more repeat${left === 1 ? "" : "s"} and I'll suggest a helper.`;
  }
  const days = gates.find((g) => g.key === "days")!;
  if (!days.met) {
    const left = ELIGIBILITY.min_distinct_days - c.distinct_day_count;
    return `Seen it enough times — I just need to see it on ${left} more day${left === 1 ? "" : "s"} to be sure it's a habit.`;
  }
  if (!gates.find((g) => g.key === "consistency")!.met) {
    return "You do this a little differently each time — once it settles into a consistent flow, I'll suggest a helper.";
  }
  if (!gates.find((g) => g.key === "time")!.met) {
    return "This is quick enough that a helper wouldn't save much yet — I'll keep watching in case it grows.";
  }
  if (!gates.find((g) => g.key === "feasibility")!.met) {
    return "Some steps here aren't safe for a helper to do on its own yet, so I won't suggest automating it.";
  }
  if (!gates.find((g) => g.key === "risk")!.met) {
    return "This touches something sensitive, so I'm holding off on suggesting automation.";
  }
  return "Almost there — a bit more signal and this becomes a suggestion.";
}
