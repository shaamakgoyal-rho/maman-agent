import { capabilitiesForToken } from "@maman/capability-catalog";
import type { PatternCandidate } from "@maman/contracts";
import type { SegmentedEpisode } from "./segmentation.js";

/**
 * Deterministic recommendation naming. Always available — the flow never
 * depends on a model. A ModelProvider may later rewrite title/summary copy
 * only; it can never change eligibility, risk, permissions, or value.
 */

const APP_LABELS: Record<string, string> = {
  crm: "Salesforce",
  spreadsheet: "your spreadsheet",
  email: "Gmail",
  calendar: "Calendar",
  research: "research tools",
  browser: "the browser",
  other: "your apps",
};

const ACTION_LABELS: Record<string, string> = {
  navigation: "Open",
  table_read: "Read a table in",
  value_committed: "Edit fields in",
  record_opened: "Look up records in",
  record_updated: "Update records in",
  copy_semantic: "Copy data from",
  paste_semantic: "Paste data into",
  table_exported: "Export a report from",
  element_activated: "Search in",
  element_focused: "Work in",
  app_activated: "Switch to",
  window_focused: "Focus",
};

export type NamingResult = {
  title: string;
  summary: string;
  generalized_intent: string;
  redacted_steps: Array<{ order: number; app: string; action: string }>;
  required_capabilities: string[];
};

export function deterministicName(
  candidate: PatternCandidate,
  members: SegmentedEpisode[],
): NamingResult {
  const categories = new Set(members.flatMap((m) => m.app_categories));
  const objectType = mostCommonObject(candidate.canonical_sequence) ?? "record";
  const outcome = candidate.canonical_sequence.at(-1)?.split(":")[2] ?? "";

  // Named recipes for well-understood shapes; generic fallback otherwise.
  let title: string;
  let intent: string;
  if (categories.has("crm") && categories.has("spreadsheet") && objectType === "account") {
    title = "Reconcile account lists with Salesforce";
    intent = "reconcile_account_list";
  } else if (categories.has("crm") && outcome === "record_updated") {
    title = `Update Salesforce ${objectType} records from your workflow`;
    intent = `update_${objectType}_records`;
  } else if (categories.has("spreadsheet") && outcome === "table_exported") {
    title = `Build your recurring ${objectType} report`;
    intent = `generate_${objectType}_report`;
  } else {
    const appList = [...categories].map((c) => APP_LABELS[c] ?? c).slice(0, 2);
    title = `Automate your ${objectType} workflow across ${appList.join(" and ")}`;
    intent = `automate_${objectType}_workflow`;
  }

  const medianMinutes = Math.round(candidate.median_duration_ms / 60_000);
  const summary =
    `I noticed you completed a similar workflow ${candidate.occurrence_count} times across ` +
    `${candidate.distinct_day_count} days. The median run took ${medianMinutes} minutes. ` +
    `I can draft a helper and show you what it would do before anything changes.`;

  // Redacted evidence steps (≤5 by default; the UI can expand).
  const seen = new Set<string>();
  const redacted_steps: NamingResult["redacted_steps"] = [];
  for (const token of candidate.canonical_sequence) {
    const [, app = "other", eventType = ""] = token.split(":");
    const key = `${app}:${eventType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    redacted_steps.push({
      order: redacted_steps.length + 1,
      app: APP_LABELS[app] ?? app,
      action: ACTION_LABELS[eventType] ?? eventType,
    });
  }

  const required = new Set<string>();
  for (const token of candidate.canonical_sequence) {
    for (const capability of capabilitiesForToken(token)) required.add(capability);
  }

  return {
    title,
    summary,
    generalized_intent: intent,
    redacted_steps,
    required_capabilities: [...required].sort(),
  };
}

function mostCommonObject(sequence: string[]): string | null {
  const counts = new Map<string, number>();
  for (const token of sequence) {
    const object = token.split(":")[5];
    if (object && object !== "-") counts.set(object, (counts.get(object) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [object, count] of counts) {
    if (count > bestCount) {
      best = object;
      bestCount = count;
    }
  }
  return best;
}
