import type { AppCategory, PatternFeatureEvent, WorkflowEvent } from "@maman/contracts";

/**
 * WorkflowEvent → PatternFeatureEvent projection. In production the Rust core
 * performs this before invoking the engine; this pure implementation serves
 * tests, the web preview, and CI.
 */

export function categorizeApp(displayName: string, domain?: string): AppCategory {
  const hay = `${displayName.toLowerCase()} ${domain?.toLowerCase() ?? ""}`;
  if (/salesforce|force\.com|hubspot/.test(hay)) return "crm";
  if (/sheets|excel|airtable/.test(hay)) return "spreadsheet";
  if (/gmail|mail|outlook/.test(hay)) return "email";
  if (/calendar/.test(hay)) return "calendar";
  if (/linkedin|apollo|zoominfo/.test(hay)) return "research";
  if (domain) return "browser";
  return "other";
}

export function toPatternFeature(
  event: WorkflowEvent,
  excludedFromLearning = false,
): PatternFeatureEvent {
  return {
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    monotonic_ms: event.monotonic_ms,
    source: event.source,
    app_category: categorizeApp(event.app.display_name, event.app.domain),
    event_type: event.event_type,
    ...(event.target.role ? { target_role: event.target.role } : {}),
    ...(event.target.semantic_type ? { semantic_type: event.target.semantic_type } : {}),
    ...(event.context.object_type ? { object_type: event.context.object_type } : {}),
    ...(bucketize(event.context.item_count)
      ? { item_count_bucket: bucketize(event.context.item_count)! }
      : {}),
    ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
    sensitivity: event.sensitivity,
    excluded_from_learning: excludedFromLearning,
  };
}

function bucketize(count: number | undefined): PatternFeatureEvent["item_count_bucket"] | null {
  if (count === undefined) return null;
  if (count <= 1) return "1";
  if (count <= 10) return "2_10";
  if (count <= 50) return "11_50";
  if (count <= 200) return "51_200";
  return "201_plus";
}
