import { describe, expect, it } from "vitest";
import {
  entryDecision,
  familySuppressed,
  gateProactiveCard,
  modeWeekday,
  outcomeFor,
  proactiveCards,
  templateWorkflow,
  type ProactiveInput,
} from "../src/lib/proactive.js";
import type { SurfacingContext } from "../src/lib/suggestion-policy.js";

/**
 * The desktop side of Layer 5. The property that matters most here is ORDERING:
 * the generic surfacing gate decides whether anything may surface, and a due
 * pack card can never override it.
 */

const CAL = { fiscal_year_start_month: 1, close_start_day: 1 };

function at(y: number, m: number, d: number, h = 10): Date {
  return new Date(y, m - 1, d, h, 0, 0, 0);
}

function input(over: Partial<ProactiveInput> = {}): ProactiveInput {
  return {
    pattern_id: "pat-1",
    signature: "sig-1",
    template_id: "finops/month_end_accruals",
    verified: { runs_matched: 9, runs_tested: 10 },
    episode_weekdays: [],
    entry: {
      status: "new",
      dismissal_reason: null,
      dismissed_at: null,
      snoozed_until: null,
    },
    ...over,
  };
}

/** An otherwise-permissive surfacing context (mirrors suggestion-policy tests). */
function ctx(over: Partial<SurfacingContext> = {}): SurfacingContext {
  return {
    now: at(2026, 8, 30, 12),
    observation_paused: false,
    private_context: false,
    fullscreen_or_presenting: false,
    screen_sharing: false,
    surfaced_today: 0,
    daily_budget: 2,
    quiet_hours_start: "18:00",
    quiet_hours_end: "08:30",
    attention_required: false,
    idle_seconds: 60,
    just_completed_workflow: true,
    snoozed_until: null,
    ...over,
  };
}

describe("template_id parsing", () => {
  it("splits pack domain from workflow id", () => {
    expect(templateWorkflow({ template_id: "finops/invoice_intake" })).toEqual({
      pack_domain: "finops",
      workflow_id: "invoice_intake",
    });
  });

  it("returns null for a novel pattern or a malformed id", () => {
    for (const id of [null, undefined, "", "finops", "/x", "finops/"]) {
      expect(templateWorkflow({ template_id: id })).toBeNull();
    }
  });
});

describe("a due card cannot override the generic gate", () => {
  const card = () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      patterns: [input()],
    });
    expect(items.length).toBeGreaterThan(0);
    return items[0]!.card;
  };

  it("surfaces when the gate allows and no quiet period applies", () => {
    expect(gateProactiveCard(card(), ctx())).toEqual({ surface: true });
  });

  it.each([
    ["observation_paused", { observation_paused: true }],
    ["private_context", { private_context: true }],
    ["screen_sharing", { screen_sharing: true }],
    ["fullscreen_or_presenting", { fullscreen_or_presenting: true }],
    ["budget_exhausted", { surfaced_today: 2 }],
    ["attention_required", { attention_required: true }],
  ] as const)("is blocked by %s, and reports that reason", (reason, patch) => {
    const gate = gateProactiveCard(card(), ctx(patch));
    expect(gate).toEqual({ surface: false, reason });
  });

  it("is blocked by quiet HOURS even on the day the close is due", () => {
    const gate = gateProactiveCard(card(), ctx({ now: at(2026, 8, 30, 20) }));
    expect(gate).toEqual({ surface: false, reason: "quiet_hours" });
  });

  it("queues (never drops) during a quiet PERIOD, reporting the release date", () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [{ start: "2026-08-28", end: "2026-09-04", label: "Audit week" }],
      patterns: [input()],
    });
    const gate = gateProactiveCard(items[0]!.card, ctx());
    expect(gate).toEqual({
      surface: false,
      reason: "quiet_period",
      queued_until: "2026-09-05",
    });
  });
});

describe("signals built from tracked patterns", () => {
  it("carries replay evidence into the pack copy", () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      patterns: [input()],
    });
    expect(items[0]!.card.copy).toContain("9/10");
    expect(items[0]!.pattern_id).toBe("pat-1");
    expect(items[0]!.signature).toBe("sig-1");
  });

  it("withholds copy when the pattern has NOT cleared verification", () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      patterns: [input({ verified: null })],
    });
    expect(items[0]!.card.copy).toBeNull();
    expect(items[0]!.card.copy_missing).toContain("runs_matched");
  });

  it("ignores novel (non-template) patterns — they are not pack workflows", () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      patterns: [input({ template_id: null })],
    });
    expect(items).toEqual([]);
  });

  it("prefers the best-verified pattern as the one the card would run", () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      patterns: [
        input({
          pattern_id: "weak",
          signature: "s-weak",
          verified: { runs_matched: 3, runs_tested: 3 },
        }),
        input({
          pattern_id: "strong",
          signature: "s-strong",
          verified: { runs_matched: 18, runs_tested: 20 },
        }),
      ],
    });
    expect(items[0]!.pattern_id).toBe("strong");
    expect(items[0]!.card.copy).toContain("18/20");
  });
});

describe("weekday inference", () => {
  it("picks the most common weekday, deterministically on ties", () => {
    // 2026-08-03 is a Monday, 2026-08-06 a Thursday.
    expect(
      modeWeekday([
        "2026-08-03T09:00:00.000Z",
        "2026-08-10T09:00:00.000Z",
        "2026-08-06T09:00:00.000Z",
      ]),
    ).toBe(new Date("2026-08-03T09:00:00.000Z").getDay());
    // A tie resolves to the lowest weekday index, not to insertion order.
    const tie = modeWeekday(["2026-08-06T09:00:00.000Z", "2026-08-03T09:00:00.000Z"]);
    expect(tie).toBe(Math.min(new Date(2026, 7, 3).getDay(), new Date(2026, 7, 6).getDay()));
  });

  it("returns undefined when there is nothing to infer from", () => {
    expect(modeWeekday([])).toBeUndefined();
    expect(modeWeekday(["not-a-date"])).toBeUndefined();
  });
});

describe("'never' suppresses the whole workflow family", () => {
  const neverEntry = {
    status: "dismissed",
    dismissal_reason: "never_suggest",
    dismissed_at: "2026-07-01T10:00:00.000Z",
    snoozed_until: null,
  };

  it("hides a SIBLING pattern of the same pack workflow", () => {
    const patterns = [
      input({ pattern_id: "pat-A", signature: "sig-A", entry: neverEntry }),
      input({ pattern_id: "pat-B", signature: "sig-B" }),
    ];
    expect(
      familySuppressed({
        now: at(2026, 8, 30),
        template_id: "finops/month_end_accruals",
        patterns,
      }),
    ).toBe(true);
  });

  it("leaves a different workflow alone", () => {
    const patterns = [
      input({ pattern_id: "pat-A", signature: "sig-A", entry: neverEntry }),
      input({ pattern_id: "pat-C", signature: "sig-C", template_id: "finops/invoice_intake" }),
    ];
    expect(
      familySuppressed({ now: at(2026, 8, 30), template_id: "finops/invoice_intake", patterns }),
    ).toBe(false);
  });

  it("does NOT hide a family that is merely backing off — that is timing, not refusal", () => {
    const patterns = [
      input({
        pattern_id: "pat-A",
        signature: "sig-A",
        entry: {
          status: "dismissed",
          dismissal_reason: "not_now",
          dismissed_at: "2026-08-29T10:00:00.000Z",
          snoozed_until: null,
        },
      }),
    ];
    expect(
      familySuppressed({
        now: at(2026, 8, 30),
        template_id: "finops/month_end_accruals",
        patterns,
      }),
    ).toBe(false);
  });

  it("a suppressed family produces no proactive card either", () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      patterns: [input({ entry: neverEntry })],
    });
    expect(items).toEqual([]);
  });

  it("an unknown pack domain is not suppressed by accident", () => {
    expect(
      familySuppressed({ now: at(2026, 8, 30), template_id: "nosuchpack/x", patterns: [] }),
    ).toBe(false);
  });
});

describe("entry → decision mapping", () => {
  it("distinguishes never from wrong from plain not-now", () => {
    const base = { snoozed_until: null };
    expect(
      entryDecision("w", "p", {
        ...base,
        status: "dismissed",
        dismissal_reason: "never_suggest",
        dismissed_at: "2026-08-01T00:00:00.000Z",
      })?.action,
    ).toBe("never_suggest");
    expect(
      entryDecision("w", "p", {
        ...base,
        status: "dismissed",
        dismissal_reason: "wrong_pattern",
        dismissed_at: "2026-08-01T00:00:00.000Z",
      })?.action,
    ).toBe("wrong");
    expect(
      entryDecision("w", "p", {
        ...base,
        status: "dismissed",
        dismissal_reason: "not_useful",
        dismissed_at: "2026-08-01T00:00:00.000Z",
      })?.action,
    ).toBe("dismissed");
  });

  it("ignores states that carry no decision", () => {
    const base = { dismissal_reason: null, dismissed_at: null, snoozed_until: null };
    expect(entryDecision("w", "p", { ...base, status: "new" })).toBeNull();
    expect(entryDecision("w", "p", { ...base, status: "viewed" })).toBeNull();
    // A snooze with no timestamp tells us nothing about when to ask again.
    expect(entryDecision("w", "p", { ...base, status: "snoozed" })).toBeNull();
  });
});

describe("outcome rows", () => {
  it("attach the card's context and never its subject text", () => {
    const { items } = proactiveCards({
      now: at(2026, 8, 30),
      calendar: CAL,
      quiet_periods: [],
      patterns: [input()],
    });
    const outcome = outcomeFor({
      pattern_id: "pat-1",
      outcome: "accepted",
      now: at(2026, 8, 30, 12),
      card: items[0]!.card,
    });
    expect(outcome).toMatchObject({
      pattern_id: "pat-1",
      workflow_id: "month_end_accruals",
      pack_domain: "finops",
      surface: "pre_close",
      outcome: "accepted",
    });
    expect(outcome.local_hour).toBe(items[0]!.card.features.local_hour);
  });
});
