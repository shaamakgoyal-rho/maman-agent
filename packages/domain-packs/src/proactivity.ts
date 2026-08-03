/**
 * Layer 5 — domain-tuned proactivity. Decides WHEN a pack workflow may be
 * offered, never WHETHER it is allowed: this module is a scheduler, not an
 * authority.
 *
 * Three invariants, each covered by a test that fails loudly if broken:
 *
 *  1. RESTRICT-ONLY. Proactivity can delay a card, queue it, suppress it, or
 *     lower its autonomy ceiling. It can never surface something the generic
 *     surfacing gate (spec §12: quiet hours, budget, private context, …) has
 *     blocked, and never raises a ceiling. `pre_stage.mode` is a CEILING and is
 *     applied through `lowerCeiling`.
 *  2. NO FABRICATED EVIDENCE. Pack copy carries placeholders like
 *     {runs_matched}/{runs_tested}. If a value is unknown, the copy is refused
 *     rather than rendered with a guess — an unrendered card is honest, an
 *     invented match rate is not.
 *  3. QUIET PERIODS QUEUE, THEY DO NOT DROP. During an audit week the card is
 *     withheld and its release date reported, so nothing is silently lost.
 *
 * Pure and deterministic: every function takes `now` explicitly, does no I/O,
 * and holds zero domain knowledge — FinOps and RevOps behaviour comes entirely
 * from pack YAML.
 */

import { lowerCeiling, type AutonomyLevel, type DomainPack, type PackWorkflow } from "./schema.js";

/* ------------------------------------------------------------------ calendar */

/**
 * Fiscal calendar configuration. Lives in user settings, not in packs: a pack
 * says `calendar: fiscal`, the company says when its fiscal periods land.
 */
export type FiscalCalendar = {
  /** Calendar month (1–12) the fiscal year begins. */
  fiscal_year_start_month: number;
  /**
   * Day of month the monthly close period opens. Clamped to the length of the
   * month, so 31 means "last day" in February.
   */
  close_start_day: number;
};

export const DEFAULT_FISCAL_CALENDAR: FiscalCalendar = {
  fiscal_year_start_month: 1,
  close_start_day: 1,
};

/** A local calendar date, detached from any timezone. */
export type CalendarDate = { year: number; month: number; day: number };

const DAY_MS = 86_400_000;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Interprets `now` in LOCAL time — quiet periods and close dates are wall-clock. */
export function localDate(now: Date): CalendarDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

export function toIsoDate(d: CalendarDate): string {
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

/** Whole days from `from` to `to`, counted on the calendar (never negative-zero). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / DAY_MS);
}

/**
 * The close start on or after `from`. A close opens every month on
 * `close_start_day` (clamped); if this month's has already passed, the next
 * month's is returned.
 */
export function nextCloseStart(from: CalendarDate, cal: FiscalCalendar): CalendarDate {
  const clamp = (year: number, month: number): CalendarDate => ({
    year,
    month,
    day: Math.min(cal.close_start_day, daysInMonth(year, month)),
  });
  const thisMonth = clamp(from.year, from.month);
  if (daysBetween(from, thisMonth) >= 0) return thisMonth;
  const nextMonth = from.month === 12 ? 1 : from.month + 1;
  const nextYear = from.month === 12 ? from.year + 1 : from.year;
  return clamp(nextYear, nextMonth);
}

/**
 * Which fiscal period a date falls in, as a 1-based month index within the
 * fiscal year. Reported alongside outcomes so a future learned policy can tell
 * "period 12" (year-end) from "period 3".
 */
export function fiscalPeriod(date: CalendarDate, cal: FiscalCalendar): number {
  const offset = date.month - cal.fiscal_year_start_month;
  return (((offset % 12) + 12) % 12) + 1;
}

/**
 * Where a date sits relative to the monthly close, as a coarse label. This is a
 * training-set feature, deliberately low-cardinality.
 */
export type CadencePhase = "pre_close" | "in_close" | "mid_period";

export function cadencePhase(
  date: CalendarDate,
  cal: FiscalCalendar,
  preCloseDays: number,
): CadencePhase {
  const close = nextCloseStart(date, cal);
  const until = daysBetween(date, close);
  if (until === 0) return "in_close";
  return until <= preCloseDays ? "pre_close" : "mid_period";
}

/* ----------------------------------------------------------- quiet periods */

/** A user-editable date range during which cards queue silently. */
export type QuietPeriod = { start: string; end: string; label?: string | undefined };

/**
 * The quiet period covering `date`, if any. Inclusive of both endpoints — a
 * one-day audit window is written start === end. Malformed or inverted ranges
 * are ignored rather than throwing: bad config must not silence Maman forever,
 * and must not crash it either.
 */
export function activeQuietPeriod(date: CalendarDate, periods: QuietPeriod[]): QuietPeriod | null {
  const iso = toIsoDate(date);
  for (const p of periods) {
    if (!isIsoDate(p.start) || !isIsoDate(p.end)) continue;
    if (p.start > p.end) continue;
    if (iso >= p.start && iso <= p.end) return p;
  }
  return null;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y = "0", m = "0", d = "0"] = s.split("-");
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** The day after a quiet period ends — when a queued card becomes releasable. */
export function quietPeriodRelease(p: QuietPeriod): string {
  const [y = "0", m = "0", d = "0"] = p.end.split("-");
  const next = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1));
  return next.toISOString().slice(0, 10);
}

/* -------------------------------------------------------- dismissal learning */

export type DismissalAction = "accepted" | "snoozed" | "dismissed" | "never_suggest" | "wrong";

/**
 * One prior decision, read from the local suggestion ledger. `workflow_id` is
 * the pack workflow (the family); `pattern_id` is the specific instance.
 */
export type SuggestionDecision = {
  action: DismissalAction;
  /** ISO instant. */
  occurred_at: string;
  workflow_id?: string | undefined;
  pattern_id?: string | undefined;
  reason?: string | undefined;
};

export type DismissalVerdict =
  | { suppressed: false }
  | {
      suppressed: true;
      /**
       * `never_family` — the user said never to a sibling of this workflow.
       * `never_pattern` — they said never to this exact pattern.
       * `backoff` — "not now", still inside the pack's backoff ladder.
       */
      reason: "never_family" | "never_pattern" | "backoff";
      /** ISO date the suppression lifts; absent means permanent. */
      until?: string;
      /** Which rung of `not_now_backoff_days` is in force (0-based). */
      ladder_index?: number;
    };

/** Dismissals that mean "not now" rather than "never". */
const BACKOFF_ACTIONS: ReadonlySet<DismissalAction> = new Set(["snoozed", "dismissed"]);

/**
 * Applies the pack's dismissal semantics.
 *
 * `never_means: suppress_workflow_family` is the meaningful one: saying never
 * to "code this invoice" must not leave Maman asking about a sibling pattern of
 * the same workflow tomorrow. With `suppress_pattern` only the exact pattern is
 * suppressed.
 *
 * Repeated "not now" walks the pack's ladder (e.g. 14 → 45 → 120 days) and
 * stays on the last rung after that; a pack with no ladder never backs off.
 * `accepted` resets the ladder — an accepted workflow is not a nuisance.
 */
export function evaluateDismissal(
  pack: DomainPack,
  input: {
    workflow_id: string;
    pattern_id?: string | undefined;
    decisions: SuggestionDecision[];
    now: Date;
  },
): DismissalVerdict {
  const learning = pack.proactivity.dismissal_learning;
  const scope = learning?.never_means ?? "suppress_workflow_family";
  const relevant = input.decisions
    .filter((d) =>
      scope === "suppress_pattern"
        ? d.pattern_id !== undefined && d.pattern_id === input.pattern_id
        : d.workflow_id === input.workflow_id,
    )
    .slice()
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  const never = relevant.find((d) => d.action === "never_suggest");
  if (never) {
    return {
      suppressed: true,
      reason: scope === "suppress_pattern" ? "never_pattern" : "never_family",
    };
  }

  const ladder = learning?.not_now_backoff_days ?? [];
  if (ladder.length === 0) return { suppressed: false };

  // Count "not now"s since the most recent acceptance: accepting clears the slate.
  const lastAccepted = relevant.filter((d) => d.action === "accepted").pop();
  const since = lastAccepted
    ? relevant.filter((d) => d.occurred_at > lastAccepted.occurred_at)
    : relevant;
  const notNows = since.filter((d) => BACKOFF_ACTIONS.has(d.action));
  const last = notNows[notNows.length - 1];
  if (!last) return { suppressed: false };

  const index = Math.min(notNows.length - 1, ladder.length - 1);
  const days = ladder[index]!;
  const from = new Date(last.occurred_at);
  if (Number.isNaN(from.getTime())) return { suppressed: false }; // unparseable: do not suppress
  const untilMs = from.getTime() + days * DAY_MS;
  if (input.now.getTime() >= untilMs) return { suppressed: false };
  return {
    suppressed: true,
    reason: "backoff",
    until: new Date(untilMs).toISOString(),
    ladder_index: index,
  };
}

/* -------------------------------------------------------------- copy render */

/**
 * Values a pack copy template may reference. Anything absent makes the copy
 * unrenderable — see invariant 2. `runs_matched`/`runs_tested` in particular
 * are evidence claims and must come from real replay verification.
 */
export type CopyVars = Record<string, string | number | undefined>;

export type RenderedCopy = { text: string } | { text: null; missing: string[] };

const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/g;

/**
 * Substitutes {placeholders}. Returns the missing variable names instead of a
 * half-rendered string, so a caller can fall back to plain honest copy rather
 * than showing "matched {runs_matched}/{runs_tested}" to a user.
 */
export function renderCopy(template: string, vars: CopyVars): RenderedCopy {
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === "") {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return String(v);
  });
  return missing.length > 0 ? { text: null, missing } : { text };
}

/* --------------------------------------------------------------- scheduling */

/** How a card was triggered. Mirrors the pack's `surface` vocabulary. */
export type ProactiveSurface =
  "pre_close" | "on_trigger" | "same_weekday_observed" | "after_verification";

export type ProactiveCard = {
  pack_domain: string;
  workflow_id: string;
  workflow_name: string;
  cadence: PackWorkflow["cadence"];
  surface: ProactiveSurface;
  /** Local date the card becomes due. */
  due_date: string;
  /** Rendered pack copy, or null when the pack copy could not be honoured. */
  copy: string | null;
  /** Placeholders the pack copy wanted but we could not supply. */
  copy_missing: string[];
  /**
   * Autonomy ceiling for pre-staged output. Only ever lowers what the caller
   * already had.
   */
  ceiling: AutonomyLevel | undefined;
  /** Set when a quiet period is holding the card; it releases on this date. */
  queued_until: string | undefined;
  quiet_period_label: string | undefined;
  /** Coarse training-set features for the outcome ledger. */
  features: { local_dow: number; local_hour: number; cadence_phase: CadencePhase };
};

/** Facts about one candidate workflow that only the caller can know. */
export type WorkflowSignal = {
  workflow_id: string;
  /** Replay-verification evidence. Omit when unverified — copy will refuse. */
  runs_matched?: number | undefined;
  runs_tested?: number | undefined;
  /** For date_driven workflows: the extracted date being watched (ISO date). */
  watched_date?: string | undefined;
  /** Which pack object the watched date came from, e.g. "renewal". */
  watched_object?: string | undefined;
  /** A display name for the record, e.g. an account. Never sensitive content. */
  subject?: string | undefined;
  /** For weekly workflows: the weekday (0–6) the worker usually does this. */
  observed_dow?: number | undefined;
  /** Prior decisions for this workflow family. */
  decisions?: SuggestionDecision[] | undefined;
  pattern_id?: string | undefined;
};

export type ProactivityContext = {
  now: Date;
  calendar: FiscalCalendar;
  /** Pack quiet periods plus any the user added in settings. */
  quiet_periods: QuietPeriod[];
  /** The ceiling already in force (from pack policy / autonomy state). */
  current_ceiling?: AutonomyLevel | undefined;
  signals: WorkflowSignal[];
};

export type SkipReason =
  | "no_signal"
  | "not_due"
  | "calendar_not_fiscal"
  | "no_watched_date"
  | "wrong_weekday"
  | "suppressed_never_family"
  | "suppressed_never_pattern"
  | "suppressed_backoff";

/**
 * `pack_domain` and `workflow_id` sit on BOTH branches: a caller correlating
 * decisions back to workflows must not have to unwrap the card first.
 */
export type ProactiveDecision =
  | { fires: true; pack_domain: string; workflow_id: string; card: ProactiveCard }
  | {
      fires: false;
      pack_domain: string;
      workflow_id: string;
      reason: SkipReason;
      /** For a backoff skip: when it lifts. */
      until?: string | undefined;
    };

/**
 * Evaluates every pack workflow against the calendar, its signals and the
 * user's dismissal history, and returns one decision per workflow.
 *
 * This answers "is this workflow due?" only. The caller must still run the
 * generic surfacing gate; a card here is a candidate, not a permission.
 */
export function evaluateProactivity(
  packs: DomainPack[],
  ctx: ProactivityContext,
): ProactiveDecision[] {
  const today = localDate(ctx.now);
  const quiet = activeQuietPeriod(today, ctx.quiet_periods);
  const out: ProactiveDecision[] = [];

  // Deterministic ordering: pack domain, then workflow id.
  const ordered = [...packs].sort((a, b) => a.domain.localeCompare(b.domain));
  for (const pack of ordered) {
    const packQuiet =
      quiet ?? activeQuietPeriod(today, pack.proactivity.quiet_periods as QuietPeriod[]);
    const workflows = [...pack.workflows].sort((a, b) => a.id.localeCompare(b.id));
    for (const wf of workflows) {
      const signal = ctx.signals.find((s) => s.workflow_id === wf.id);
      if (!signal) {
        out.push({
          fires: false,
          pack_domain: pack.domain,
          workflow_id: wf.id,
          reason: "no_signal",
        });
        continue;
      }

      const dismissal = evaluateDismissal(pack, {
        workflow_id: wf.id,
        pattern_id: signal.pattern_id,
        decisions: signal.decisions ?? [],
        now: ctx.now,
      });
      if (dismissal.suppressed) {
        out.push({
          fires: false,
          pack_domain: pack.domain,
          workflow_id: wf.id,
          reason:
            dismissal.reason === "never_family"
              ? "suppressed_never_family"
              : dismissal.reason === "never_pattern"
                ? "suppressed_never_pattern"
                : "suppressed_backoff",
          until: dismissal.until,
        });
        continue;
      }

      const timing = timingFor(pack, wf, signal, today, ctx.calendar);
      if (!timing.due) {
        out.push({
          fires: false,
          pack_domain: pack.domain,
          workflow_id: wf.id,
          reason: timing.reason,
        });
        continue;
      }

      const copyTemplate = timing.copy;
      const rendered = copyTemplate
        ? renderCopy(copyTemplate, {
            date: timing.reference_date,
            days: timing.days_out,
            workflow: wf.name,
            account: signal.subject,
            subject: signal.subject,
            runs_matched: signal.runs_matched,
            runs_tested: signal.runs_tested,
          })
        : ({ text: null, missing: [] } as RenderedCopy);

      // pre_stage.mode is a CEILING: it may only lower what is already in force.
      const preStageMode = wf.pre_stage?.mode;
      const ceiling = !preStageMode
        ? ctx.current_ceiling
        : ctx.current_ceiling === undefined
          ? preStageMode // impose one where there was none
          : lowerCeiling(ctx.current_ceiling, preStageMode);

      out.push({
        fires: true,
        pack_domain: pack.domain,
        workflow_id: wf.id,
        card: {
          pack_domain: pack.domain,
          workflow_id: wf.id,
          workflow_name: wf.name,
          cadence: wf.cadence,
          surface: timing.surface,
          due_date: toIsoDate(today),
          copy: rendered.text,
          copy_missing: "missing" in rendered ? rendered.missing : [],
          ceiling,
          queued_until: packQuiet ? quietPeriodRelease(packQuiet) : undefined,
          quiet_period_label: packQuiet?.label,
          features: {
            local_dow: ctx.now.getDay(),
            local_hour: ctx.now.getHours(),
            cadence_phase: cadencePhase(today, ctx.calendar, timing.pre_close_days ?? 0),
          },
        },
      });
    }
  }
  return out;
}

type Timing =
  | {
      due: true;
      surface: ProactiveSurface;
      copy: string | undefined;
      reference_date: string | undefined;
      days_out: number | undefined;
      pre_close_days?: number | undefined;
    }
  | { due: false; reason: SkipReason };

/**
 * Cadence → timing rule, read from `proactivity.suggestion_timing` and
 * `pre_stage`. The keys (`fiscal_monthly_workflows`, `weekly_workflows`, …) are
 * the pack's vocabulary; code only knows how to look them up.
 */
function timingFor(
  pack: DomainPack,
  wf: PackWorkflow,
  signal: WorkflowSignal,
  today: CalendarDate,
  cal: FiscalCalendar,
): Timing {
  const timing = pack.proactivity.suggestion_timing[`${wf.cadence}_workflows`];

  switch (wf.cadence) {
    case "fiscal_monthly": {
      if (pack.proactivity.calendar !== "fiscal")
        return { due: false, reason: "calendar_not_fiscal" };
      const lead = timing?.days_before ?? wf.pre_stage?.days_before_close;
      if (lead === undefined) return { due: false, reason: "not_due" };
      const close = nextCloseStart(today, cal);
      const out = daysBetween(today, close);
      if (out > lead) return { due: false, reason: "not_due" };
      return {
        due: true,
        surface: "pre_close",
        copy: timing?.copy,
        reference_date: toIsoDate(close),
        days_out: out,
        pre_close_days: lead,
      };
    }

    case "date_driven":
    case "event_driven": {
      // A watched date (e.g. an extracted renewal term_end) plus the trigger's
      // lead_days. The trigger is matched on the pack object it watches.
      const trigger = pack.proactivity.event_triggers.find(
        (t) => signal.watched_object !== undefined && t.watch === signal.watched_object,
      );
      const lead = trigger?.lead_days ?? wf.pre_stage?.days_before_renewal;
      if (!signal.watched_date || !isIsoDate(signal.watched_date)) {
        return { due: false, reason: "no_watched_date" };
      }
      if (lead === undefined) return { due: false, reason: "not_due" };
      const [y = "0", m = "0", d = "0"] = signal.watched_date.split("-");
      const target: CalendarDate = { year: Number(y), month: Number(m), day: Number(d) };
      const out = daysBetween(today, target);
      if (out > lead) return { due: false, reason: "not_due" };
      return {
        due: true,
        surface: "on_trigger",
        copy: trigger?.copy ?? timing?.copy,
        reference_date: signal.watched_date,
        days_out: out,
      };
    }

    case "weekly": {
      // A weekly workflow the pack gave no timing for must NOT nag daily: with
      // no configured surface there is nothing to schedule against.
      if (!timing) return { due: false, reason: "not_due" };
      // "Suggest the sweep when they usually do it" — only on the observed day.
      if (timing.surface === "same_weekday_observed") {
        if (signal.observed_dow === undefined) return { due: false, reason: "not_due" };
        const dow = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
        if (dow !== signal.observed_dow) return { due: false, reason: "wrong_weekday" };
      }
      return {
        due: true,
        surface: "same_weekday_observed",
        copy: timing.copy,
        reference_date: toIsoDate(today),
        days_out: 0,
      };
    }

    case "continuous":
      // Nothing calendar-driven: these surface after verification, which the
      // existing detection path already owns.
      return { due: false, reason: "not_due" };
  }
}

/* ------------------------------------------------------------ outcome record */

/**
 * A surfacing outcome plus the context features it happened in — the local,
 * privacy-safe training set for a future learned surfacing policy (WS4). Only
 * ids, enums and small integers: never labels, never content.
 */
export type SuggestionOutcome = {
  pattern_id: string;
  workflow_id: string | null;
  pack_domain: string | null;
  cadence: string | null;
  surface: string | null;
  outcome: DismissalAction;
  reason: string | null;
  local_dow: number;
  local_hour: number;
  cadence_phase: CadencePhase | null;
  /** Seconds between the card becoming due and the user acting on it. */
  seconds_since_trigger: number | null;
  occurred_at: string;
};

/** Builds the outcome row for a decision the user just made about a card. */
export function buildOutcome(input: {
  pattern_id: string;
  outcome: DismissalAction;
  reason?: string | null;
  now: Date;
  card?: ProactiveCard | undefined;
  /** When the card became due, if known. */
  triggered_at?: string | undefined;
}): SuggestionOutcome {
  const triggeredMs = input.triggered_at ? new Date(input.triggered_at).getTime() : NaN;
  const since = Number.isNaN(triggeredMs)
    ? null
    : Math.max(0, Math.round((input.now.getTime() - triggeredMs) / 1000));
  return {
    pattern_id: input.pattern_id,
    workflow_id: input.card?.workflow_id ?? null,
    pack_domain: input.card?.pack_domain ?? null,
    cadence: input.card?.cadence ?? null,
    surface: input.card?.surface ?? null,
    outcome: input.outcome,
    reason: input.reason ?? null,
    local_dow: input.card?.features.local_dow ?? input.now.getDay(),
    local_hour: input.card?.features.local_hour ?? input.now.getHours(),
    cadence_phase: input.card?.features.cadence_phase ?? null,
    seconds_since_trigger: since,
    occurred_at: input.now.toISOString(),
  };
}
