import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeQuietPeriod,
  buildOutcome,
  cadencePhase,
  daysBetween,
  evaluateDismissal,
  evaluateProactivity,
  fiscalPeriod,
  localDate,
  nextCloseStart,
  quietPeriodRelease,
  renderCopy,
  validatePack,
  type DomainPack,
  type FiscalCalendar,
  type SuggestionDecision,
  type WorkflowSignal,
} from "../src/index.js";

/**
 * Layer 5 scheduling. The three invariants under test:
 *   1. proactivity may only restrict (never raises a ceiling, never overrides
 *      the generic surfacing gate — which is why nothing here returns "allowed"),
 *   2. pack copy is never rendered with invented evidence,
 *   3. quiet periods QUEUE a card, they do not drop it.
 */

const PACKS = join(import.meta.dirname, "..", "..", "..", "domain", "packs");
function shipped(name: string): DomainPack {
  const r = validatePack(JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.pack;
}
const finops = shipped("finops");
const revops = shipped("revops");

const CAL: FiscalCalendar = { fiscal_year_start_month: 1, close_start_day: 1 };

/** Local-time construction, since calendar logic is wall-clock by design. */
function at(y: number, m: number, d: number, h = 10): Date {
  return new Date(y, m - 1, d, h, 0, 0, 0);
}

describe("fiscal calendar", () => {
  it("finds the next close start, rolling into the next month once passed", () => {
    expect(nextCloseStart({ year: 2026, month: 8, day: 20 }, CAL)).toEqual({
      year: 2026,
      month: 9,
      day: 1,
    });
    // On the close day itself, that day IS the next close.
    expect(nextCloseStart({ year: 2026, month: 9, day: 1 }, CAL)).toEqual({
      year: 2026,
      month: 9,
      day: 1,
    });
  });

  it("rolls the year over in December", () => {
    expect(nextCloseStart({ year: 2026, month: 12, day: 5 }, CAL)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });

  it("clamps a close day that the month does not have", () => {
    const late: FiscalCalendar = { fiscal_year_start_month: 1, close_start_day: 31 };
    expect(nextCloseStart({ year: 2027, month: 2, day: 1 }, late)).toEqual({
      year: 2027,
      month: 2,
      day: 28,
    });
    // Leap year gets the 29th.
    expect(nextCloseStart({ year: 2028, month: 2, day: 1 }, late)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  it("numbers fiscal periods from the configured FY start", () => {
    const feb: FiscalCalendar = { fiscal_year_start_month: 2, close_start_day: 1 };
    expect(fiscalPeriod({ year: 2026, month: 2, day: 3 }, feb)).toBe(1);
    expect(fiscalPeriod({ year: 2026, month: 1, day: 3 }, feb)).toBe(12); // year-end
    expect(fiscalPeriod({ year: 2026, month: 8, day: 3 }, CAL)).toBe(8);
  });

  it("labels the cadence phase for the outcome ledger", () => {
    expect(cadencePhase({ year: 2026, month: 9, day: 1 }, CAL, 3)).toBe("in_close");
    expect(cadencePhase({ year: 2026, month: 8, day: 30 }, CAL, 3)).toBe("pre_close");
    expect(cadencePhase({ year: 2026, month: 8, day: 10 }, CAL, 3)).toBe("mid_period");
  });

  it("counts calendar days across month boundaries", () => {
    expect(daysBetween({ year: 2026, month: 8, day: 29 }, { year: 2026, month: 9, day: 1 })).toBe(3);
    expect(daysBetween({ year: 2026, month: 9, day: 2 }, { year: 2026, month: 9, day: 1 })).toBe(-1);
  });
});

describe("pre-close cards (finops, fiscal_monthly)", () => {
  // finops invoice_intake / close_prep: suggestion_timing.fiscal_monthly_workflows
  // is { surface: pre_close, days_before: 3 }.
  const signals = (over: Partial<WorkflowSignal> = {}): WorkflowSignal[] =>
    finops.workflows.map((w) => ({
      workflow_id: w.id,
      runs_matched: 9,
      runs_tested: 10,
      ...over,
    }));

  function fiscalMonthlyDecision(now: Date) {
    const monthly = finops.workflows.filter((w) => w.cadence === "fiscal_monthly");
    expect(monthly.length).toBeGreaterThan(0); // the pack must still exercise this path
    const decisions = evaluateProactivity([finops], {
      now,
      calendar: CAL,
      quiet_periods: [],
      signals: signals(),
    });
    return decisions.filter((d) => monthly.some((w) => w.id === d.workflow_id));
  }

  it("does not fire in mid-period", () => {
    const d = fiscalMonthlyDecision(at(2026, 8, 10));
    expect(d.every((x) => !x.fires)).toBe(true);
  });

  it("fires inside the pack's days_before window, with the pack's copy", () => {
    const d = fiscalMonthlyDecision(at(2026, 8, 30)); // 2 days before Sep 1
    const fired = d.filter((x) => x.fires);
    expect(fired.length).toBeGreaterThan(0);
    const card = fired[0]!.fires && fired[0]!.card;
    if (!card) throw new Error("expected a card");
    expect(card.surface).toBe("pre_close");
    expect(card.cadence).toBe("fiscal_monthly");
    // Pack copy: "Close starts {date}. I can pre-stage {workflow} — last cycle
    // matched {runs_matched}/{runs_tested}."
    expect(card.copy).toContain("2026-09-01");
    expect(card.copy).toContain("9/10");
    expect(card.copy_missing).toEqual([]);
  });

  it("offers pre-staged output at a DRAFT-ONLY ceiling, never higher", () => {
    const d = fiscalMonthlyDecision(at(2026, 8, 30)).filter((x) => x.fires);
    for (const x of d) {
      if (!x.fires) continue;
      // Whatever the pack asks for, it is a ceiling — not full autonomy.
      if (x.card.ceiling !== undefined) {
        expect(["draft_only", "stage_only", "dry_run_first", "never_autonomous"]).toContain(
          x.card.ceiling,
        );
      }
    }
  });

  it("cannot RAISE a ceiling that is already stricter", () => {
    const strict = evaluateProactivity([finops], {
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      current_ceiling: "never_autonomous",
      signals: signals(),
    }).filter((d) => d.fires);
    for (const d of strict) {
      if (d.fires) expect(d.card.ceiling).toBe("never_autonomous");
    }
  });
});

describe("renewal-lead cards (revops, date_driven)", () => {
  // revops event_triggers: { watch: renewal, field: term_end, lead_days: 30 }
  const renewal = revops.workflows.find((w) => w.id === "renewal_motion")!;

  function decide(now: Date, termEnd: string) {
    return evaluateProactivity([revops], {
      now,
      calendar: { fiscal_year_start_month: 1, close_start_day: 1 },
      quiet_periods: [],
      signals: [
        {
          workflow_id: renewal.id,
          watched_object: "renewal",
          watched_date: termEnd,
          subject: "Northwind",
          runs_matched: 4,
          runs_tested: 5,
        },
      ],
    }).find((d) => d.workflow_id === renewal.id)!;
  }

  it("stays quiet outside the lead window", () => {
    const d = decide(at(2026, 8, 2), "2026-11-01"); // 91 days out, lead is 30
    expect(d.fires).toBe(false);
    if (!d.fires) expect(d.reason).toBe("not_due");
  });

  it("fires at lead_days with the pack copy and the real day count", () => {
    const d = decide(at(2026, 8, 2), "2026-08-25"); // 23 days out
    expect(d.fires).toBe(true);
    if (!d.fires) return;
    // "{account}'s renewal is {days} out. I can draft the renewal packet —
    // matched {runs_matched}/{runs_tested} on past renewals."
    expect(d.card.copy).toContain("Northwind");
    expect(d.card.copy).toContain("23");
    expect(d.card.copy).toContain("4/5");
    expect(d.card.surface).toBe("on_trigger");
  });

  it("refuses to fire when there is no extracted date to stand on", () => {
    const d = evaluateProactivity([revops], {
      now: at(2026, 8, 2),
      calendar: CAL,
      quiet_periods: [],
      signals: [{ workflow_id: renewal.id, watched_object: "renewal" }],
    }).find((x) => x.workflow_id === renewal.id)!;
    expect(d.fires).toBe(false);
    if (!d.fires) expect(d.reason).toBe("no_watched_date");
  });

  it("ignores a malformed date rather than trusting it", () => {
    const d = decide(at(2026, 8, 2), "2026-02-31"); // not a real day
    expect(d.fires).toBe(false);
  });
});

describe("weekly workflows fire on the observed weekday", () => {
  // revops suggestion_timing.weekly_workflows = { surface: same_weekday_observed }
  const weekly = revops.workflows.filter((w) => w.cadence === "weekly");

  it("only on the day the worker actually does it", () => {
    expect(weekly.length).toBeGreaterThan(0);
    const wf = weekly[0]!;
    const monday = at(2026, 8, 3); // a Monday
    const onDay = evaluateProactivity([revops], {
      now: monday,
      calendar: CAL,
      quiet_periods: [],
      signals: [{ workflow_id: wf.id, observed_dow: 1, runs_matched: 3, runs_tested: 3 }],
    }).find((d) => d.workflow_id === wf.id)!;
    expect(onDay.fires).toBe(true);

    const offDay = evaluateProactivity([revops], {
      now: monday,
      calendar: CAL,
      quiet_periods: [],
      signals: [{ workflow_id: wf.id, observed_dow: 4, runs_matched: 3, runs_tested: 3 }],
    }).find((d) => d.workflow_id === wf.id)!;
    expect(offDay.fires).toBe(false);
    if (!offDay.fires) expect(offDay.reason).toBe("wrong_weekday");
  });
});

describe("quiet periods QUEUE, they never drop", () => {
  it("still produces the card, marked queued until the period ends", () => {
    const decisions = evaluateProactivity([finops], {
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [{ start: "2026-08-28", end: "2026-09-04", label: "Audit week" }],
      signals: finops.workflows.map((w) => ({
        workflow_id: w.id,
        runs_matched: 9,
        runs_tested: 10,
      })),
    });
    const fired = decisions.filter((d) => d.fires);
    expect(fired.length).toBeGreaterThan(0); // NOT dropped
    for (const d of fired) {
      if (!d.fires) continue;
      expect(d.card.queued_until).toBe("2026-09-05");
      expect(d.card.quiet_period_label).toBe("Audit week");
    }
  });

  it("is inclusive of both endpoints and releases the day after", () => {
    const p = { start: "2026-08-28", end: "2026-08-28", label: "one day" };
    expect(activeQuietPeriod({ year: 2026, month: 8, day: 28 }, [p])).toEqual(p);
    expect(activeQuietPeriod({ year: 2026, month: 8, day: 29 }, [p])).toBeNull();
    expect(quietPeriodRelease(p)).toBe("2026-08-29");
    expect(quietPeriodRelease({ start: "2026-08-01", end: "2026-08-31" })).toBe("2026-09-01");
  });

  it("ignores malformed or inverted ranges instead of silencing Maman forever", () => {
    const today = { year: 2026, month: 8, day: 30 };
    expect(activeQuietPeriod(today, [{ start: "nope", end: "2026-09-04" }])).toBeNull();
    expect(activeQuietPeriod(today, [{ start: "2026-09-04", end: "2026-08-01" }])).toBeNull();
    expect(activeQuietPeriod(today, [{ start: "2026-02-30", end: "2026-12-31" }])).toBeNull();
  });
});

describe("dismissal learning", () => {
  const d = (
    action: SuggestionDecision["action"],
    occurred_at: string,
    workflow_id = "invoice_intake",
  ): SuggestionDecision => ({ action, occurred_at, workflow_id });

  it("'never' suppresses the whole workflow FAMILY, not one pattern", () => {
    // finops dismissal_learning.never_means = suppress_workflow_family
    const verdict = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      pattern_id: "pat-B", // a DIFFERENT pattern than the one dismissed
      decisions: [{ ...d("never_suggest", "2026-07-01T10:00:00.000Z"), pattern_id: "pat-A" }],
      now: at(2026, 8, 2),
    });
    expect(verdict.suppressed).toBe(true);
    if (verdict.suppressed) {
      expect(verdict.reason).toBe("never_family");
      expect(verdict.until).toBeUndefined(); // permanent until the user reverses it
    }
  });

  it("walks the pack's backoff ladder on repeated 'not now'", () => {
    // finops not_now_backoff_days = [14, 45, 120]
    const first = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      decisions: [d("dismissed", "2026-08-01T10:00:00.000Z")],
      now: at(2026, 8, 10),
    });
    expect(first.suppressed).toBe(true);
    if (first.suppressed) expect(first.ladder_index).toBe(0);

    // Past 14 days: it may ask again.
    const lifted = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      decisions: [d("dismissed", "2026-08-01T10:00:00.000Z")],
      now: at(2026, 8, 20),
    });
    expect(lifted.suppressed).toBe(false);

    // Third "not now" → the 120-day rung.
    const third = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      decisions: [
        d("dismissed", "2026-05-01T10:00:00.000Z"),
        d("dismissed", "2026-06-01T10:00:00.000Z"),
        d("dismissed", "2026-08-01T10:00:00.000Z"),
      ],
      now: at(2026, 8, 20),
    });
    expect(third.suppressed).toBe(true);
    if (third.suppressed) expect(third.ladder_index).toBe(2);
  });

  it("stays on the last rung rather than running off the ladder", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      d("dismissed", `2026-0${(i % 8) + 1}-01T10:00:00.000Z`),
    );
    const v = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      decisions: many,
      now: at(2026, 8, 5),
    });
    expect(v.suppressed).toBe(true);
    if (v.suppressed) expect(v.ladder_index).toBe(2); // ladder length 3
  });

  it("accepting clears the ladder — an accepted workflow is not a nuisance", () => {
    const v = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      decisions: [
        d("dismissed", "2026-07-01T10:00:00.000Z"),
        d("dismissed", "2026-07-10T10:00:00.000Z"),
        d("accepted", "2026-07-20T10:00:00.000Z"),
      ],
      now: at(2026, 8, 2),
    });
    expect(v.suppressed).toBe(false);
  });

  it("ignores decisions about other workflows", () => {
    const v = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      decisions: [d("never_suggest", "2026-07-01T10:00:00.000Z", "close_prep")],
      now: at(2026, 8, 2),
    });
    expect(v.suppressed).toBe(false);
  });

  it("does not suppress on an unparseable timestamp", () => {
    const v = evaluateDismissal(finops, {
      workflow_id: "invoice_intake",
      decisions: [d("dismissed", "not-a-date")],
      now: at(2026, 8, 2),
    });
    expect(v.suppressed).toBe(false);
  });

  it("suppression beats timing — a suppressed workflow never produces a card", () => {
    const decisions = evaluateProactivity([finops], {
      now: at(2026, 8, 30), // inside the pre-close window
      calendar: CAL,
      quiet_periods: [],
      signals: finops.workflows.map((w) => ({
        workflow_id: w.id,
        runs_matched: 9,
        runs_tested: 10,
        decisions: [{ action: "never_suggest", occurred_at: "2026-07-01T10:00:00.000Z", workflow_id: w.id }],
      })),
    });
    expect(decisions.every((d) => !d.fires)).toBe(true);
    expect(decisions.some((d) => !d.fires && d.reason === "suppressed_never_family")).toBe(true);
  });
});

describe("copy never fabricates evidence", () => {
  it("renders when every placeholder is supplied", () => {
    expect(renderCopy("matched {runs_matched}/{runs_tested}", { runs_matched: 9, runs_tested: 10 })).toEqual(
      { text: "matched 9/10" },
    );
  });

  it("refuses — and names what was missing — rather than guessing", () => {
    expect(renderCopy("matched {runs_matched}/{runs_tested}", { runs_matched: 9 })).toEqual({
      text: null,
      missing: ["runs_tested"],
    });
  });

  it("a card with unverified evidence carries copy=null, not a made-up rate", () => {
    const decisions = evaluateProactivity([finops], {
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      // No runs_matched/runs_tested: nothing has been replay-verified yet.
      signals: finops.workflows.map((w) => ({ workflow_id: w.id })),
    }).filter((d) => d.fires);
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      if (!d.fires) continue;
      expect(d.card.copy).toBeNull();
      expect(d.card.copy_missing).toContain("runs_matched");
    }
  });
});

describe("determinism and shape", () => {
  it("is independent of pack order and repeatable", () => {
    const ctx = {
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      signals: [...finops.workflows, ...revops.workflows].map((w) => ({
        workflow_id: w.id,
        runs_matched: 5,
        runs_tested: 5,
      })),
    };
    const a = evaluateProactivity([finops, revops], ctx);
    const b = evaluateProactivity([revops, finops], ctx);
    expect(a).toEqual(b);
    expect(evaluateProactivity([finops, revops], ctx)).toEqual(a);
  });

  it("reports no_signal for workflows the caller knows nothing about", () => {
    const d = evaluateProactivity([finops], {
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      signals: [],
    });
    expect(d.length).toBe(finops.workflows.length);
    expect(d.every((x) => !x.fires && x.reason === "no_signal")).toBe(true);
  });

  it("localDate reads wall-clock, so a close date is not shifted by timezone", () => {
    expect(localDate(at(2026, 8, 30, 23))).toEqual({ year: 2026, month: 8, day: 30 });
  });
});

describe("outcome rows are privacy-safe training features", () => {
  it("captures context without any content", () => {
    const card = evaluateProactivity([revops], {
      now: at(2026, 8, 2),
      calendar: CAL,
      quiet_periods: [],
      signals: [
        {
          workflow_id: "renewal_motion",
          watched_object: "renewal",
          watched_date: "2026-08-25",
          subject: "Northwind",
          runs_matched: 4,
          runs_tested: 5,
        },
      ],
    }).find((d) => d.fires);
    if (!card || !card.fires) throw new Error("expected a card");

    const outcome = buildOutcome({
      pattern_id: "pat-1",
      outcome: "accepted",
      now: at(2026, 8, 2, 11),
      card: card.card,
      triggered_at: at(2026, 8, 2, 10).toISOString(),
    });
    expect(outcome).toMatchObject({
      pattern_id: "pat-1",
      workflow_id: "renewal_motion",
      pack_domain: "revops",
      cadence: "date_driven",
      surface: "on_trigger",
      outcome: "accepted",
      seconds_since_trigger: 3600,
    });
    // No label text, no account name, no free-form content anywhere.
    expect(JSON.stringify(outcome)).not.toContain("Northwind");
  });

  it("degrades honestly when there is no trigger time", () => {
    const o = buildOutcome({ pattern_id: "p", outcome: "dismissed", now: at(2026, 8, 2) });
    expect(o.seconds_since_trigger).toBeNull();
    expect(o.cadence_phase).toBeNull();
    expect(o.workflow_id).toBeNull();
  });
});
