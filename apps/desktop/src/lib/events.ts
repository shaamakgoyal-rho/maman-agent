import type { WorkflowContext, WorkflowEvent } from "@maman/contracts";
import { emitAppEvent, invokeCommand, isTauri } from "./bridge.js";

/**
 * Event-store bridge. In Tauri, calls the Rust encrypted store (panel-only
 * commands). In the web preview (CI / non-macOS demo), an in-memory store
 * provides the same interface so every screen and flow stays exercisable.
 */

export type TimelineEntry = {
  event_id: string;
  occurred_at: string;
  source: string;
  app_category: string;
  event_type: string;
  sensitivity: string;
  app_display_name: string;
  semantic_type: string | null;
  object_type: string | null;
  duration_ms: number | null;
  excluded_from_learning: boolean;
};

export type IngestResult = {
  stored: number;
  dropped_paused: number;
  dropped_denied: number;
  dropped_not_allowlisted: number;
  boundary_events: number;
  rejected_forbidden: number;
};

// ---- web preview fallback (in-memory) ----

const memory: TimelineEntry[] = [];
const memoryRaw: WorkflowEvent[] = [];

/** Raw events for the web-preview pattern projection (Tauri path uses Rust). */
export function getMemoryRawEvents(): WorkflowEvent[] {
  return memoryRaw;
}

/** The JS mirror of the Rust domain→category mapping, for preview + emission. */
export function appCategoryOf(e: WorkflowEvent): string {
  const domain = e.app.domain ?? "";
  if (domain.includes("force.com") || domain.includes("salesforce.com")) return "crm";
  if (domain.includes("docs.google")) return "spreadsheet";
  if (domain.includes("linkedin.com")) return "research";
  if (domain.includes("slack.com") || domain.includes("teams.microsoft.com")) return "messaging";
  return "browser";
}

/**
 * The redacted context of one event, as the trigger service will hear it.
 * Field-for-field the canonical-token vocabulary — subscribing to this can
 * never become a side-channel to content, because content is not in it.
 */
export function contextOf(e: WorkflowEvent): WorkflowContext {
  return {
    source: e.source,
    app_category: appCategoryOf(e),
    event_type: e.event_type,
    target_role: e.target.role ?? "-",
    semantic_type: e.target.semantic_type ?? "-",
    object_type: e.context.object_type ?? "-",
    ...(e.app.domain ? { domain: e.app.domain } : {}),
    occurred_at: e.occurred_at,
  };
}

function toEntry(e: WorkflowEvent): TimelineEntry {
  return {
    event_id: e.event_id,
    occurred_at: e.occurred_at,
    source: e.source,
    app_category: appCategoryOf(e),
    event_type: e.event_type,
    sensitivity: e.sensitivity,
    app_display_name: e.app.display_name,
    semantic_type: e.target.semantic_type ?? null,
    object_type: e.context.object_type ?? null,
    duration_ms: e.duration_ms ?? null,
    excluded_from_learning: false,
  };
}

export async function ingestEvents(
  events: WorkflowEvent[],
  opts: { observationPaused: boolean },
): Promise<IngestResult> {
  if (isTauri()) {
    const result = await invokeCommand<IngestResult>("events_ingest", {
      eventsJson: JSON.stringify(events),
    });
    // Trigger evaluation hears what was STORED, not what was attempted: a
    // paused or denied event never wakes an agent.
    if (result.stored > 0) {
      for (const e of events)
        void emitAppEvent({ type: "workflow_context", context: contextOf(e) });
    }
    return result;
  }
  if (opts.observationPaused) {
    return {
      stored: 0,
      dropped_paused: events.length,
      dropped_denied: 0,
      dropped_not_allowlisted: 0,
      boundary_events: 0,
      rejected_forbidden: 0,
    };
  }
  memory.unshift(...events.map(toEntry));
  memoryRaw.push(...events);
  for (const e of events) void emitAppEvent({ type: "workflow_context", context: contextOf(e) });
  return {
    stored: events.length,
    dropped_paused: 0,
    dropped_denied: 0,
    dropped_not_allowlisted: 0,
    boundary_events: 0,
    rejected_forbidden: 0,
  };
}

export async function fetchTimeline(limit = 100, offset = 0): Promise<TimelineEntry[]> {
  if (isTauri()) {
    return invokeCommand<TimelineEntry[]>("events_timeline", { limit, offset });
  }
  return memory.slice(offset, offset + limit);
}

export async function deleteEvent(eventId: string): Promise<boolean> {
  if (isTauri()) return invokeCommand<boolean>("events_delete", { eventId });
  const i = memory.findIndex((e) => e.event_id === eventId);
  if (i >= 0) memory.splice(i, 1);
  return i >= 0;
}

export async function deleteAllEvents(): Promise<number> {
  if (isTauri()) return invokeCommand<number>("events_delete_all");
  const n = memory.length;
  memory.length = 0;
  return n;
}

export async function deleteAppHistory(displayName: string): Promise<number> {
  if (isTauri()) return invokeCommand<number>("events_delete_app", { displayName });
  const before = memory.length;
  for (let i = memory.length - 1; i >= 0; i--) {
    if (memory[i]!.app_display_name === displayName) memory.splice(i, 1);
  }
  return before - memory.length;
}

export async function setExcludedFromLearning(
  eventId: string,
  excluded: boolean,
): Promise<boolean> {
  if (isTauri()) return invokeCommand<boolean>("events_set_excluded", { eventId, excluded });
  const entry = memory.find((e) => e.event_id === eventId);
  if (entry) entry.excluded_from_learning = excluded;
  return Boolean(entry);
}
