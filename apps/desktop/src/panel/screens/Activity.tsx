import { useCallback, useEffect, useState } from "react";
import {
  deleteAllEvents,
  deleteEvent,
  fetchTimeline,
  setExcludedFromLearning,
  type TimelineEntry,
} from "../../lib/events.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";

/**
 * "What Maman saw" — the human-readable local observation timeline with
 * per-event deletion, exclude-from-learning, and delete-all.
 */

const EVENT_COPY: Record<string, string> = {
  app_activated: "Switched to",
  window_focused: "Focused a window in",
  element_focused: "Focused an element in",
  element_activated: "Clicked in",
  value_committed: "Edited a field in",
  navigation: "Navigated in",
  record_opened: "Opened a record in",
  record_updated: "Updated a record in",
  table_read: "Read a table in",
  table_exported: "Exported a table from",
  copy_semantic: "Copied from",
  paste_semantic: "Pasted into",
  boundary_redacted: "Entered a private context",
  idle_started: "Went idle",
  idle_ended: "Came back",
};

export function Activity() {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const refresh = useCallback(async () => {
    setEntries(await fetchTimeline(200, 0));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (entries === null) return <Muted>Loading local timeline…</Muted>;

  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing recorded yet"
        body="Once observation is on, this timeline shows every event Maman stored on this Mac — and you can delete any of it. Try the Run demo workflow button on Home."
      />
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <SectionTitle>What Maman saw</SectionTitle>
          {confirmingAll ? (
            <span className="flex gap-2">
              <Button
                variant="danger"
                onClick={async () => {
                  setBusy(true);
                  await deleteAllEvents();
                  await refresh();
                  setBusy(false);
                  setConfirmingAll(false);
                }}
                disabled={busy}
              >
                Confirm delete all
              </Button>
              <Button variant="secondary" onClick={() => setConfirmingAll(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmingAll(true)}>
              Delete all
            </Button>
          )}
        </div>
        <Muted>
          {entries.length} events stored on this Mac, encrypted. Deleting removes the local record
          within a minute everywhere, including anything queued to sync.
        </Muted>
      </Card>

      <ul className="space-y-1.5" aria-label="Local observation timeline">
        {entries.map((e) => (
          <li key={e.event_id} className="card px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm truncate">
                  {EVENT_COPY[e.event_type] ?? e.event_type}{" "}
                  {e.event_type !== "boundary_redacted" && (
                    <span className="font-medium">{e.app_display_name}</span>
                  )}
                  {e.semantic_type && (
                    <span className="text-muted"> · {e.semantic_type.replaceAll("_", " ")}</span>
                  )}
                </p>
                <p className="text-xs text-muted tabular-nums">
                  {new Date(e.occurred_at).toLocaleString()} · {e.app_category}
                  {e.duration_ms ? ` · ${Math.round(e.duration_ms / 1000)}s` : ""}
                  {e.excluded_from_learning && (
                    <StatusPill tone="muted"> excluded from learning</StatusPill>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  ariaLabel={`Exclude event from learning`}
                  onClick={async () => {
                    await setExcludedFromLearning(e.event_id, !e.excluded_from_learning);
                    await refresh();
                  }}
                >
                  {e.excluded_from_learning ? "Include" : "Exclude"}
                </Button>
                <Button
                  variant="ghost"
                  ariaLabel="Delete this event"
                  onClick={async () => {
                    await deleteEvent(e.event_id);
                    await refresh();
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
