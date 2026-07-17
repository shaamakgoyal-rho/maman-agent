import { useEffect, useState } from "react";
import { emitAppEvent } from "../../lib/bridge.js";
import { useAgents } from "../../lib/agents.js";
import { useRecommendations, type RecommendationWithState } from "../../lib/recommendations.js";
import type { SnoozeOption } from "../../lib/suggestion-policy.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";

/**
 * Journey C: recommendation cards with full evidence, ordered by opportunity
 * then recency. Actions: Preview, Create agent, Not now (snooze), Never
 * suggest this, This is wrong.
 */

const FILTERS = ["New", "Snoozed", "Accepted", "Dismissed"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_STATUS: Record<Filter, string[]> = {
  New: ["new", "viewed"],
  Snoozed: ["snoozed"],
  Accepted: ["accepted"],
  Dismissed: ["dismissed"],
};

export function Suggestions() {
  const { items, hydrated, refresh, act } = useRecommendations();
  const [filter, setFilter] = useState<Filter>("New");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = items.filter((i) => FILTER_STATUS[filter].includes(i.entry.status));

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5" role="tablist" aria-label="Suggestion filters">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f ? "bg-primary text-white" : "bg-panel border border-line text-muted"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {!hydrated && <Muted>Analyzing your local workflow patterns…</Muted>}

      {hydrated && visible.length === 0 && (
        <EmptyState
          title={filter === "New" ? "No suggestions yet" : `Nothing ${filter.toLowerCase()}`}
          body={
            filter === "New"
              ? "Suggestions appear after Maman notices a workflow repeat at least three times across two days — run the demo workflow on Home to see one."
              : "Items you act on land in this filter."
          }
        />
      )}

      {visible.map((item) => (
        <SuggestionCard
          key={item.signature}
          item={item}
          expanded={expanded === item.signature}
          onToggleExpand={() => setExpanded(expanded === item.signature ? null : item.signature)}
          onAct={act}
        />
      ))}
    </div>
  );
}

function SuggestionCard({
  item,
  expanded,
  onToggleExpand,
  onAct,
}: {
  item: RecommendationWithState;
  expanded: boolean;
  onToggleExpand: () => void;
  onAct: (signature: string, action: never) => Promise<void>;
}) {
  const rec = item.recommendation;
  const act = onAct as (
    signature: string,
    action: { type: string; option?: SnoozeOption; reason?: string },
  ) => Promise<void>;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const minutes = Math.round(rec.evidence.median_duration_ms / 60_000);
  const steps = expanded ? rec.evidence.redacted_steps : rec.evidence.redacted_steps.slice(0, 5);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <SectionTitle>{rec.title}</SectionTitle>
        <StatusPill
          tone={
            rec.risk_level === "low"
              ? "success"
              : rec.risk_level === "medium"
                ? "warning"
                : "danger"
          }
        >
          {rec.risk_level} risk
        </StatusPill>
      </div>
      <Muted>{rec.summary}</Muted>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted tabular-nums">
        <span>
          Seen {rec.evidence.occurrence_count}× on {rec.evidence.distinct_day_count} days
        </span>
        <span>Median {minutes} min manually</span>
        <span>~{Math.round(rec.projected_minutes_saved_weekly)} min/week back</span>
        <span>
          ${rec.expected_cost_usd_low.toFixed(2)}–${rec.expected_cost_usd_high.toFixed(2)} per run ·{" "}
          {Math.round(rec.confidence * 100)}% confidence
        </span>
      </div>

      <div className="mt-2">
        <p className="text-xs font-medium text-ink">What I noticed (redacted)</p>
        <ol className="mt-1 space-y-0.5 text-xs text-muted list-decimal pl-4">
          {steps.map((s) => (
            <li key={s.order}>
              {s.action} {s.app}
            </li>
          ))}
        </ol>
        {rec.evidence.redacted_steps.length > 5 && (
          <button className="mt-1 text-xs text-primary" onClick={onToggleExpand}>
            {expanded ? "Show fewer steps" : `Show all ${rec.evidence.redacted_steps.length} steps`}
          </button>
        )}
      </div>

      <div className="mt-2">
        <p className="text-xs font-medium text-ink">Would need</p>
        <p className="text-xs text-muted">
          {rec.required_capabilities.join(", ") || "local processing only"}
        </p>
      </div>

      {item.entry.status !== "accepted" && item.entry.status !== "dismissed" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={async () => {
              await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
              const created = await useAgents
                .getState()
                .createDraft(item.candidate, "reconcile_account_list", rec.summary);
              await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });
              if (created.ok) {
                await act(item.signature, { type: "accepted" });
              }
            }}
          >
            Create agent
          </Button>
          <Button variant="secondary" onClick={onToggleExpand}>
            Preview
          </Button>
          <div className="relative">
            <Button variant="secondary" onClick={() => setSnoozeOpen((v) => !v)}>
              Not now
            </Button>
            {snoozeOpen && (
              <div className="absolute z-10 mt-1 card p-1 flex flex-col">
                {(
                  [
                    ["1h", "1 hour"],
                    ["4h", "4 hours"],
                    ["today", "Today"],
                    ["1w", "One week"],
                  ] as Array<[SnoozeOption, string]>
                ).map(([option, label]) => (
                  <button
                    key={option}
                    className="rounded px-3 py-1 text-left text-xs hover:bg-bg"
                    onClick={() => {
                      setSnoozeOpen(false);
                      void act(item.signature, { type: "snoozed", option });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={() => void act(item.signature, { type: "never_suggest" })}
          >
            Never suggest this
          </Button>
          <Button variant="ghost" onClick={() => void act(item.signature, { type: "wrong" })}>
            This is wrong
          </Button>
        </div>
      )}
      {item.entry.status === "accepted" && (
        <p className="mt-3 text-xs text-success">
          Draft agent created — inspect its full plan in the Agents tab. Nothing runs or changes
          until you approve it there.
        </p>
      )}
    </Card>
  );
}
