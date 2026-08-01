import {
  uuidv7,
  workflowEventSchema,
  type WorkflowEvent,
  type WorkflowEventType,
} from "@maman/contracts";

/**
 * Primary demo fixture (spec §24): the account-list reconciliation workflow.
 *
 * Six similar episodes across three days, each 8–14 simulated active minutes,
 * with small deterministic variations so clustering is genuinely exercised:
 *   1. open a CSV/Sheets-like account list
 *   2. normalize company domains
 *   3. look up matching Salesforce Accounts
 *   4. compare owner / employee count / website / segment
 *   5. propose updates
 *   6. produce a reconciliation report
 *
 * Everything is deterministic: a seeded PRNG drives IDs, timing jitter, and
 * variations, so the same seed always yields byte-identical fixtures.
 */

export type FixtureOptions = {
  /** Deterministic seed. */
  seed?: number;
  /** Identity attached to every event. */
  device_id?: string;
  user_id?: string;
  organization_id?: string;
  /** Local calendar day of the first episode (UTC ISO date, e.g. "2026-07-14"). */
  start_day?: string;
};

/** Mulberry32 — tiny deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type StepTemplate = {
  source: WorkflowEvent["source"];
  display_name: string;
  domain?: string;
  event_type: WorkflowEventType;
  role?: string;
  semantic_type?: string;
  object_type?: string;
  page_type?: string;
  item_count?: number;
  /** Nominal duration of this step in seconds (jittered per episode). */
  seconds: number;
  /** Included only in episodes listed here (undefined = all episodes). */
  only_episodes?: number[];
};

const SHEET = { display_name: "Google Sheets", domain: "docs.google.com" } as const;
const SFDC = { display_name: "Salesforce", domain: "acme.lightning.force.com" } as const;

/** The canonical reconciliation step sequence with optional-variation steps. */
const RECONCILIATION_STEPS: StepTemplate[] = [
  { source: "chrome", ...SHEET, event_type: "navigation", page_type: "spreadsheet", seconds: 8 },
  {
    source: "chrome",
    ...SHEET,
    event_type: "table_read",
    role: "grid",
    semantic_type: "account_list",
    object_type: "account",
    item_count: 10,
    seconds: 55,
  },
  // normalize domains (edit column) — twice in some episodes
  {
    source: "chrome",
    ...SHEET,
    event_type: "value_committed",
    role: "cell",
    semantic_type: "company_domain",
    object_type: "account",
    seconds: 95,
  },
  {
    source: "chrome",
    ...SHEET,
    event_type: "value_committed",
    role: "cell",
    semantic_type: "company_domain",
    object_type: "account",
    seconds: 60,
    only_episodes: [1, 3, 5],
  },
  { source: "chrome", ...SFDC, event_type: "navigation", page_type: "object_home", seconds: 12 },
  {
    source: "chrome",
    ...SFDC,
    event_type: "element_activated",
    role: "searchbox",
    semantic_type: "account_search",
    object_type: "account",
    seconds: 25,
  },
  {
    source: "chrome",
    ...SFDC,
    event_type: "record_opened",
    role: "row",
    semantic_type: "account",
    object_type: "account",
    seconds: 40,
  },
  {
    source: "chrome",
    ...SFDC,
    event_type: "table_read",
    role: "table",
    semantic_type: "account_fields",
    object_type: "account",
    item_count: 4,
    seconds: 80,
  },
  // compare and copy values back and forth
  {
    source: "chrome",
    ...SFDC,
    event_type: "copy_semantic",
    role: "field",
    semantic_type: "account_field",
    object_type: "account",
    seconds: 35,
  },
  {
    source: "chrome",
    ...SHEET,
    event_type: "paste_semantic",
    role: "cell",
    semantic_type: "account_field",
    object_type: "account",
    seconds: 30,
  },
  // second SFDC lookup round in some episodes (loop variation)
  {
    source: "chrome",
    ...SFDC,
    event_type: "record_opened",
    role: "row",
    semantic_type: "account",
    object_type: "account",
    seconds: 45,
    only_episodes: [0, 2, 4],
  },
  {
    source: "chrome",
    ...SFDC,
    event_type: "record_updated",
    role: "field",
    semantic_type: "account_field",
    object_type: "account",
    seconds: 70,
  },
  // produce reconciliation report
  {
    source: "chrome",
    ...SHEET,
    event_type: "table_exported",
    role: "grid",
    semantic_type: "reconciliation_report",
    object_type: "account",
    item_count: 10,
    seconds: 45,
  },
];

/** Episode start times: two per day at 09:40 and 15:10 local-ish (UTC used). */
const EPISODE_STARTS: Array<{ dayOffset: number; hour: number; minute: number }> = [
  { dayOffset: 0, hour: 9, minute: 40 },
  { dayOffset: 0, hour: 15, minute: 10 },
  { dayOffset: 1, hour: 10, minute: 5 },
  { dayOffset: 1, hour: 16, minute: 20 },
  { dayOffset: 2, hour: 9, minute: 55 },
  { dayOffset: 2, hour: 14, minute: 45 },
];

export function reconciliationFixture(opts: FixtureOptions = {}): WorkflowEvent[] {
  const seed = opts.seed ?? 20260714;
  const rand = mulberry32(seed);
  const device_id = opts.device_id ?? uuidv7({ timestampMs: 1, random: rand });
  const user_id = opts.user_id ?? uuidv7({ timestampMs: 2, random: rand });
  const organization_id = opts.organization_id ?? uuidv7({ timestampMs: 3, random: rand });
  const startDay = new Date(`${opts.start_day ?? "2026-07-14"}T00:00:00.000Z`);

  const events: WorkflowEvent[] = [];
  let monotonic = 10_000;

  EPISODE_STARTS.forEach((start, episodeIndex) => {
    const t0 =
      startDay.getTime() +
      start.dayOffset * 86_400_000 +
      start.hour * 3_600_000 +
      start.minute * 60_000;
    let t = t0;

    for (const step of RECONCILIATION_STEPS) {
      if (step.only_episodes && !step.only_episodes.includes(episodeIndex)) continue;
      // ±20% deterministic jitter keeps episodes similar but not identical.
      const jitter = 0.8 + rand() * 0.4;
      const durationMs = Math.round(step.seconds * 1000 * jitter);
      t += durationMs;
      monotonic += durationMs;

      events.push(
        workflowEventSchema.parse({
          schema_version: 1,
          event_id: uuidv7({ timestampMs: t, random: rand }),
          device_id,
          user_id,
          organization_id,
          occurred_at: new Date(t).toISOString(),
          monotonic_ms: monotonic,
          source: step.source,
          app: { display_name: step.display_name, domain: step.domain },
          event_type: step.event_type,
          target: {
            ...(step.role ? { role: step.role } : {}),
            ...(step.semantic_type ? { semantic_type: step.semantic_type } : {}),
            stable_id_hash: `h_${step.event_type}_${step.role ?? "none"}`,
          },
          context: {
            ...(step.page_type ? { page_type: step.page_type } : {}),
            ...(step.object_type ? { object_type: step.object_type } : {}),
            ...(step.item_count ? { item_count: step.item_count } : {}),
          },
          duration_ms: durationMs,
          sensitivity: "internal",
          redaction: { applied: false, reasons: [] },
        } satisfies WorkflowEvent),
      );
    }

    // idle boundary after each episode
    t += 6 * 60_000;
    monotonic += 6 * 60_000;
    events.push(
      workflowEventSchema.parse({
        schema_version: 1,
        event_id: uuidv7({ timestampMs: t, random: rand }),
        device_id,
        user_id,
        organization_id,
        occurred_at: new Date(t).toISOString(),
        monotonic_ms: monotonic,
        source: "demo",
        app: { display_name: "System" },
        event_type: "idle_started",
        target: {},
        context: {},
        sensitivity: "public",
        redaction: { applied: false, reasons: [] },
      } satisfies WorkflowEvent),
    );
  });

  return events;
}

/**
 * Demo-history fixture (the 3-minute demo arc): a realistic month of the
 * reconciliation workflow — `total` recorded runs spread two-per-workday, with
 * `divergent_runs` of them missing the Salesforce update step (the worker did
 * it differently that day). The divergent runs land INSIDE the most recent
 * verification window, so the card truthfully shows an imperfect score:
 * 19/21 reads as honest; 21/21 reads as staged.
 */
export function demoHistoryFixture(
  opts: FixtureOptions & { total?: number; divergent_runs?: number[] } = {},
): WorkflowEvent[] {
  const seed = opts.seed ?? 20260801;
  const rand = mulberry32(seed);
  const device_id = opts.device_id ?? uuidv7({ timestampMs: 1, random: rand });
  const user_id = opts.user_id ?? uuidv7({ timestampMs: 2, random: rand });
  const organization_id = opts.organization_id ?? uuidv7({ timestampMs: 3, random: rand });
  const startDay = new Date(`${opts.start_day ?? "2026-07-06"}T00:00:00.000Z`);
  const total = opts.total ?? 23;
  // 0-indexed runs that skip the Salesforce update step (default: runs 18 and
  // 22 of 23 — both inside a 21-run verification window).
  const divergent = new Set(opts.divergent_runs ?? [17, 21]);

  const events: WorkflowEvent[] = [];
  let monotonic = 10_000;

  for (let run = 0; run < total; run++) {
    // Two runs per day at 09:40 and 15:10; weekends skipped.
    const workday = Math.floor(run / 2);
    const dayOffset = workday + Math.floor(workday / 5) * 2;
    const hour = run % 2 === 0 ? 9 : 15;
    const minute = run % 2 === 0 ? 40 : 10;
    const t0 = startDay.getTime() + dayOffset * 86_400_000 + hour * 3_600_000 + minute * 60_000;
    let t = t0;

    for (const step of RECONCILIATION_STEPS) {
      // History runs share one canonical shape (duration jitter still varies);
      // the optional-variation steps stay out so the replay score is exactly
      // the seeded story: every divergence on the card is one we planted.
      if (step.only_episodes) continue;
      // The divergent runs skip the Salesforce update — the exact step the
      // replay verifier will name on the card.
      if (divergent.has(run) && step.event_type === "record_updated") continue;
      const jitter = 0.8 + rand() * 0.4;
      const durationMs = Math.round(step.seconds * 1000 * jitter);
      t += durationMs;
      monotonic += durationMs;

      events.push(
        workflowEventSchema.parse({
          schema_version: 1,
          event_id: uuidv7({ timestampMs: t, random: rand }),
          device_id,
          user_id,
          organization_id,
          occurred_at: new Date(t).toISOString(),
          monotonic_ms: monotonic,
          source: step.source,
          app: { display_name: step.display_name, domain: step.domain },
          event_type: step.event_type,
          target: {
            ...(step.role ? { role: step.role } : {}),
            ...(step.semantic_type ? { semantic_type: step.semantic_type } : {}),
            stable_id_hash: `h_${step.event_type}_${step.role ?? "none"}`,
          },
          context: {
            ...(step.page_type ? { page_type: step.page_type } : {}),
            ...(step.object_type ? { object_type: step.object_type } : {}),
            ...(step.item_count ? { item_count: step.item_count } : {}),
          },
          duration_ms: durationMs,
          sensitivity: "internal",
          redaction: { applied: false, reasons: [] },
        } satisfies WorkflowEvent),
      );
    }

    // idle boundary closes each run
    t += 6 * 60_000;
    monotonic += 6 * 60_000;
    events.push(
      workflowEventSchema.parse({
        schema_version: 1,
        event_id: uuidv7({ timestampMs: t, random: rand }),
        device_id,
        user_id,
        organization_id,
        occurred_at: new Date(t).toISOString(),
        monotonic_ms: monotonic,
        source: "demo",
        app: { display_name: "System" },
        event_type: "idle_started",
        target: {},
        context: {},
        sensitivity: "public",
        redaction: { applied: false, reasons: [] },
      } satisfies WorkflowEvent),
    );
  }

  return events;
}

/**
 * Unrelated fixture: scattered, non-repeating activity that must yield ZERO
 * recommendations (varied apps, no repeated sequence, single occurrences).
 */
export function unrelatedFixture(opts: FixtureOptions = {}): WorkflowEvent[] {
  const seed = opts.seed ?? 99_991;
  const rand = mulberry32(seed);
  const device_id = opts.device_id ?? uuidv7({ timestampMs: 1, random: rand });
  const user_id = opts.user_id ?? uuidv7({ timestampMs: 2, random: rand });
  const organization_id = opts.organization_id ?? uuidv7({ timestampMs: 3, random: rand });
  const startDay = new Date(`${opts.start_day ?? "2026-07-14"}T00:00:00.000Z`);

  const scattered: Array<[string, string | undefined, WorkflowEventType, string]> = [
    ["Slack", "app.slack.com", "navigation", "channel"],
    ["LinkedIn", "linkedin.com", "record_opened", "profile"],
    ["Google Calendar", "calendar.google.com", "element_activated", "event"],
    ["Salesforce", "acme.lightning.force.com", "navigation", "dashboard"],
    ["Google Sheets", "docs.google.com", "value_committed", "budget_cell"],
    ["Slack", "app.slack.com", "paste_semantic", "message_link"],
    ["LinkedIn", "linkedin.com", "table_read", "search_results"],
  ];

  const events: WorkflowEvent[] = [];
  let monotonic = 5_000;
  let t = startDay.getTime() + 11 * 3_600_000;

  scattered.forEach(([name, domain, type, semantic], i) => {
    // long gaps so nothing clusters into one episode family
    t += (25 + Math.round(rand() * 40)) * 60_000;
    monotonic += 60_000;
    events.push(
      workflowEventSchema.parse({
        schema_version: 1,
        event_id: uuidv7({ timestampMs: t, random: rand }),
        device_id,
        user_id,
        organization_id,
        occurred_at: new Date(t).toISOString(),
        monotonic_ms: monotonic,
        source: "chrome",
        app: { display_name: name, ...(domain ? { domain } : {}) },
        event_type: type,
        target: { semantic_type: semantic, stable_id_hash: `u_${i}` },
        context: {},
        duration_ms: 20_000,
        sensitivity: "internal",
        redaction: { applied: false, reasons: [] },
      } satisfies WorkflowEvent),
    );
  });

  return events;
}
