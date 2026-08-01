import { useEffect, useState } from "react";
import { emitAppEvent } from "../../lib/bridge.js";
import { useAgents } from "../../lib/agents.js";
import {
  useRecommendations,
  type FormingItem,
  type RecommendationWithState,
} from "../../lib/recommendations.js";
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
  const { items, forming, hydrated, refresh, act } = useRecommendations();
  const [filter, setFilter] = useState<Filter>("New");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = items.filter((i) => FILTER_STATUS[filter].includes(i.entry.status));
  // The forming funnel only makes sense next to New suggestions.
  const showForming = filter === "New" && forming.length > 0;

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

      {filter === "New" && (
        <PipelineLegend trackedCount={forming.length} readyCount={visible.length} />
      )}

      {!hydrated && <Muted>Analyzing your local workflow patterns…</Muted>}

      {hydrated && visible.length === 0 && !showForming && (
        <EmptyState
          title={filter === "New" ? "No suggestions yet" : `Nothing ${filter.toLowerCase()}`}
          body={
            filter === "New"
              ? "A suggestion appears only after Maman notices a repeated workflow AND has tested a helper against your own recorded runs. Seed the demo history on Home to see one."
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

      {showForming && (
        <div className="space-y-2 pt-1">
          <div>
            <SectionTitle>Forming — what I'm watching</SectionTitle>
            <Muted>
              These repeated workflows haven't become suggestions yet. Each check below is a real
              bar a pattern must clear before I offer a helper — no surprises.
            </Muted>
          </div>
          {forming.map((f) => (
            <FormingCard
              key={f.signature}
              item={f}
              expanded={expanded === f.signature}
              onToggleExpand={() => setExpanded(expanded === f.signature ? null : f.signature)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The tracked → forming → suggested pipeline, made explicit. */
function PipelineLegend({
  trackedCount,
  readyCount,
}: {
  trackedCount: number;
  readyCount: number;
}) {
  const stage = (label: string, sub: string, active: boolean) => (
    <div className="flex-1 text-center">
      <div
        className={`mx-auto mb-1 h-1.5 w-full rounded-full ${active ? "bg-primary" : "bg-line"}`}
      />
      <p className={`text-[11px] font-medium ${active ? "text-ink" : "text-muted"}`}>{label}</p>
      <p className="text-[10px] text-muted">{sub}</p>
    </div>
  );
  return (
    <Card>
      <div className="flex items-start gap-2">
        {stage("Observed", "allowed apps", true)}
        {stage("Forming", `${trackedCount} watching`, trackedCount > 0)}
        {stage("Suggested", readyCount > 0 ? `${readyCount} ready` : "when ready", readyCount > 0)}
      </div>
      <Muted>
        Maman watches the work you allowed, groups repeats into a workflow, and offers a helper only
        once that workflow clears every check.
      </Muted>
    </Card>
  );
}

function FormingCard({
  item,
  expanded,
  onToggleExpand,
}: {
  item: FormingItem;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const { progress } = item;
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <SectionTitle>{item.title}</SectionTitle>
        <StatusPill tone="muted">Watching</StatusPill>
      </div>

      {/* Progress toward becoming a suggestion. */}
      <div className="mt-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>Progress to a suggestion</span>
          <span className="tabular-nums">
            {progress.metCount}/{progress.total} checks
          </span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.round(progress.ratio * 100)}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-ink">{progress.nextStep}</p>
      </div>

      <button className="mt-2 text-xs text-primary" onClick={onToggleExpand}>
        {expanded ? "Hide details" : "Why isn't this a suggestion yet?"}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-ink">Checks</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {progress.gates.map((g) => (
                <li key={g.key} className="flex items-center justify-between gap-2">
                  <span className={g.met ? "text-ink" : "text-muted"}>
                    {g.met ? "✓" : "○"} {g.label}
                  </span>
                  <span className="tabular-nums text-muted">{g.detail}</span>
                </li>
              ))}
            </ul>
          </div>
          {item.steps.length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink">What I've seen (redacted)</p>
              <ol className="mt-1 space-y-0.5 text-xs text-muted list-decimal pl-4">
                {item.steps.slice(0, 6).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * THE card. One workflow Maman built an agent for and PROVED against the
 * worker's own recorded runs. Headline (editable name), the score, an
 * expandable per-run list naming each divergence in plain language, and
 * exactly three actions: Try it / Not now / Never. No prompt box, no
 * configuration — if the worker had to configure something, the card failed.
 */
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
  const v = item.verification;
  const act = onAct as (
    signature: string,
    action: { type: string; option?: SnoozeOption; reason?: string; title?: string },
  ) => Promise<void>;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const title = item.entry.custom_title ?? rec.title;
  const divergences = v.results.filter((r) => r.verdict !== "match");

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <input
            value={draftTitle}
            autoFocus
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setEditing(false);
                void act(item.signature, { type: "renamed", title: draftTitle });
              }
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={() => {
              setEditing(false);
              void act(item.signature, { type: "renamed", title: draftTitle });
            }}
            aria-label="Workflow name"
            className="flex-1 rounded-lg border border-line bg-panel px-2 py-1 text-sm font-semibold"
          />
        ) : (
          <button
            className="text-left"
            title="Rename this workflow"
            onClick={() => {
              setDraftTitle(title);
              setEditing(true);
            }}
          >
            <SectionTitle>{title}</SectionTitle>
          </button>
        )}
        <StatusPill tone="success">verified</StatusPill>
      </div>

      {/* The proof — every number here is a real replayed run. */}
      <p className="mt-1 text-sm text-ink">
        I can do this for you — I tested it against your last{" "}
        <span className="font-semibold tabular-nums">{v.runs_tested}</span> runs and matched{" "}
        <span className="font-semibold tabular-nums">{v.runs_matched}</span>.
      </p>
      <Muted>
        ~{Math.round(rec.projected_minutes_saved_weekly)} min/week of repeated work, seen{" "}
        {rec.evidence.occurrence_count}× on {rec.evidence.distinct_day_count} days. It will draft
        and stage only — nothing changes without your approval.
      </Muted>

      <button className="mt-2 text-xs text-primary" onClick={onToggleExpand}>
        {expanded ? "Hide the run-by-run results" : "See the run-by-run results"}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <ul className="space-y-0.5 text-xs">
            {v.results.map((r, i) => (
              <li key={r.episode_id} className="flex items-start justify-between gap-2">
                <span className={r.verdict === "match" ? "text-ink" : "text-muted"}>
                  {r.verdict === "match" ? "✓" : "○"} Run {v.results.length - i} ·{" "}
                  {new Date(r.started_at).toLocaleDateString()}
                </span>
                <span className="text-right text-muted">
                  {r.verdict === "match"
                    ? "matched"
                    : `diverged at step ${r.divergence_step}: you did “${r.observed ?? "something else"}” instead of “${r.expected}”`}
                </span>
              </li>
            ))}
          </ul>
          {divergences.length > 0 && (
            <Muted>
              The {divergences.length === 1 ? "divergence is" : "divergences are"} left in on
              purpose — an honest score beats a perfect one.
            </Muted>
          )}
          <div>
            <p className="text-xs font-medium text-ink">What I noticed (typed events only)</p>
            <ol className="mt-1 space-y-0.5 text-xs text-muted list-decimal pl-4">
              {rec.evidence.redacted_steps.map((s) => (
                <li key={s.order}>
                  {s.action} {s.app}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

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
            Try it
          </Button>
          <Button
            variant="secondary"
            onClick={() => void act(item.signature, { type: "snoozed", option: "2w" })}
          >
            Not now
          </Button>
          <Button
            variant="ghost"
            onClick={() => void act(item.signature, { type: "never_suggest" })}
          >
            Never
          </Button>
        </div>
      )}
      {item.entry.status === "accepted" && (
        <p className="mt-3 text-xs text-success">
          Draft agent created — inspect its full plan in the Agents tab. It drafts and stages only;
          every step needs your approval until its record says otherwise.
        </p>
      )}
    </Card>
  );
}
