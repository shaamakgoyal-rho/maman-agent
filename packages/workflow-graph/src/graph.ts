import { z } from "zod";
import type { PatternFeatureEvent } from "@maman/contracts";
import { capabilitiesForToken } from "@maman/capability-catalog";

/**
 * Personal Workflow Graph — a private, per-user structural model of how this
 * person works. Content-free by construction: nodes and edges carry hashes,
 * categories, and object references — never field values or page content.
 */

export const workflowObjectRefSchema = z
  .object({
    provider: z.string().min(1), // "salesforce", "google_sheets", …
    objectType: z.string().min(1), // "opportunity", "account", …
    stableIdHash: z.string().min(8),
    source: z.enum(["api", "browser", "desktop"]),
    urlFingerprint: z.string().optional(),
  })
  .strict();
export type WorkflowObjectRef = z.infer<typeof workflowObjectRefSchema>;

/** Activity node key: app_category + event_type + semantic_type. */
export type ActivityKey = string;

const activityStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    total_duration_ms: z.number().nonnegative(),
    failure_count: z.number().int().nonnegative(),
    correction_count: z.number().int().nonnegative(),
    approval_grant_count: z.number().int().nonnegative(),
    approval_reject_count: z.number().int().nonnegative(),
  })
  .strict();

const transitionSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    count: z.number().int().positive(),
    median_gap_ms: z.number().nonnegative(),
  })
  .strict();

export const workflowGraphSchema = z
  .object({
    schema_version: z.literal(1),
    owner_user_id: z.string(),
    activities: z.record(z.string(), activityStatsSchema),
    transitions: z.array(transitionSchema),
    objects: z.array(
      workflowObjectRefSchema.extend({ touch_count: z.number().int().positive() }).strict(),
    ),
    /** Providers with a live connector (capability availability signal). */
    connected_providers: z.array(z.string()),
  })
  .strict();
export type WorkflowGraphData = z.infer<typeof workflowGraphSchema>;

export function activityKey(e: PatternFeatureEvent): ActivityKey {
  return `${e.app_category}:${e.event_type}:${e.semantic_type ?? "-"}`;
}

export function emptyGraph(ownerUserId: string): WorkflowGraphData {
  return {
    schema_version: 1,
    owner_user_id: ownerUserId,
    activities: {},
    transitions: [],
    objects: [],
    connected_providers: [],
  };
}

/** Folds a batch of feature events into the graph (pure — returns a new graph). */
export function addObservations(
  graph: WorkflowGraphData,
  events: PatternFeatureEvent[],
): WorkflowGraphData {
  const next: WorkflowGraphData = structuredClone(graph);
  const sorted = [...events].sort((a, b) => a.monotonic_ms - b.monotonic_ms);
  const gaps = new Map<string, number[]>();

  let previous: PatternFeatureEvent | null = null;
  for (const event of sorted) {
    if (event.event_type === "idle_started" || event.event_type === "boundary_redacted") {
      previous = null;
      continue;
    }
    const key = activityKey(event);
    const stats = (next.activities[key] ??= {
      count: 0,
      total_duration_ms: 0,
      failure_count: 0,
      correction_count: 0,
      approval_grant_count: 0,
      approval_reject_count: 0,
    });
    stats.count += 1;
    stats.total_duration_ms += event.duration_ms ?? 0;

    if (previous) {
      const from = activityKey(previous);
      const gapKey = `${from}→${key}`;
      const gap = Math.max(0, event.monotonic_ms - previous.monotonic_ms);
      const list = gaps.get(gapKey) ?? [];
      list.push(gap);
      gaps.set(gapKey, list);
    }
    previous = event;
  }

  for (const [gapKey, list] of gaps) {
    const [from = "", to = ""] = gapKey.split("→");
    const existing = next.transitions.find((t) => t.from === from && t.to === to);
    const median = list.sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
    if (existing) {
      existing.count += list.length;
      existing.median_gap_ms = Math.round((existing.median_gap_ms + median) / 2);
    } else {
      next.transitions.push({ from, to, count: list.length, median_gap_ms: median });
    }
  }
  return next;
}

/** Records a business-object touch (from browser, API, or desktop signals). */
export function touchObject(graph: WorkflowGraphData, ref: WorkflowObjectRef): WorkflowGraphData {
  const validated = workflowObjectRefSchema.parse(ref);
  const next = structuredClone(graph);
  const existing = next.objects.find(
    (o) =>
      o.provider === validated.provider &&
      o.objectType === validated.objectType &&
      o.stableIdHash === validated.stableIdHash,
  );
  if (existing) {
    existing.touch_count += 1;
    // Signal joining: the same object seen from a second source keeps ONE node.
    // Prefer api > browser > desktop as the canonical source label.
    const rank = { api: 3, browser: 2, desktop: 1 } as const;
    if (rank[validated.source] > rank[existing.source]) existing.source = validated.source;
    if (validated.urlFingerprint && !existing.urlFingerprint) {
      existing.urlFingerprint = validated.urlFingerprint;
    }
  } else {
    next.objects.push({ ...validated, touch_count: 1 });
  }
  return next;
}

export function recordCorrection(graph: WorkflowGraphData, key: ActivityKey): WorkflowGraphData {
  const next = structuredClone(graph);
  const stats = next.activities[key];
  if (stats) stats.correction_count += 1;
  return next;
}

export function recordFailure(graph: WorkflowGraphData, key: ActivityKey): WorkflowGraphData {
  const next = structuredClone(graph);
  const stats = next.activities[key];
  if (stats) stats.failure_count += 1;
  return next;
}

export function recordApproval(
  graph: WorkflowGraphData,
  key: ActivityKey,
  granted: boolean,
): WorkflowGraphData {
  const next = structuredClone(graph);
  const stats = next.activities[key];
  if (stats) {
    if (granted) stats.approval_grant_count += 1;
    else stats.approval_reject_count += 1;
  }
  return next;
}

export function setConnectedProviders(
  graph: WorkflowGraphData,
  providers: string[],
): WorkflowGraphData {
  return { ...structuredClone(graph), connected_providers: [...providers].sort() };
}

// ---- connector-promotion opportunities ----

export type ConnectorOpportunity = {
  provider: string;
  activity_key: ActivityKey;
  observation_count: number;
  estimated_minutes_spent_weekly: number;
  replaces_capability_ids: string[];
};

const ACTIVITY_PROVIDER: Record<string, string> = {
  crm: "salesforce",
  spreadsheet: "google_sheets",
  email: "gmail",
  calendar: "google_calendar",
};

/**
 * Browser-heavy activities that a connector could execute through an API,
 * where the connector is NOT yet connected — the seed of a recommendation like
 * “Connecting Salesforce would replace ~11 clicks per update”.
 */
export function connectorOpportunities(
  graph: WorkflowGraphData,
  opts: { min_observations?: number } = {},
): ConnectorOpportunity[] {
  const minObservations = opts.min_observations ?? 5;
  const results: ConnectorOpportunity[] = [];
  for (const [key, stats] of Object.entries(graph.activities)) {
    if (stats.count < minObservations) continue;
    const [category = "", eventType = "", semantic = "-"] = key.split(":");
    const provider = ACTIVITY_PROVIDER[category];
    if (!provider || graph.connected_providers.includes(provider)) continue;
    // Manual write-ish activity that an API capability could replace.
    const token = `chrome:${category}:${eventType}:-:${semantic}:-`;
    const capabilities = capabilitiesForToken(token);
    if (capabilities.length === 0) continue;
    if (
      ![
        "record_updated",
        "value_committed",
        "paste_semantic",
        "record_opened",
        "table_read",
      ].includes(eventType)
    ) {
      continue;
    }
    results.push({
      provider,
      activity_key: key,
      observation_count: stats.count,
      estimated_minutes_spent_weekly:
        Math.round(
          (((stats.total_duration_ms / Math.max(1, stats.count)) * stats.count) / 60_000) * 100,
        ) / 100,
      replaces_capability_ids: capabilities,
    });
  }
  return results.sort((a, b) => b.observation_count - a.observation_count);
}

/** Validating (de)serialization for local persistence. */
export function serializeGraph(graph: WorkflowGraphData): string {
  return JSON.stringify(workflowGraphSchema.parse(graph));
}
export function deserializeGraph(json: string): WorkflowGraphData {
  return workflowGraphSchema.parse(JSON.parse(json));
}
