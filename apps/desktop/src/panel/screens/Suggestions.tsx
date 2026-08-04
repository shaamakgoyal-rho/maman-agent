import { useEffect, useState } from "react";
import { describeProposedHelper } from "@maman/agent-runtime";
import { stepPhrase } from "@maman/pattern-engine";
import { emitAppEvent } from "../../lib/bridge.js";
import { useAgents } from "../../lib/agents.js";
import {
  useRecommendations,
  type FormingItem,
  type RecommendationWithState,
} from "../../lib/recommendations.js";
import type { ProactiveItem } from "../../lib/proactive.js";
import type { SnoozeOption } from "../../lib/suggestion-policy.js";
import { useSettings } from "../../state/settings.js";
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
  const { items, forming, proactive, hydrated, refresh, act } = useRecommendations();
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

      {filter === "New" && proactive.length > 0 && (
        <div className="space-y-2">
          <div>
            <SectionTitle>Coming up — on your calendar</SectionTitle>
            <Muted>
              These are workflows your domain pack schedules, not new patterns. Timing comes from
              your fiscal calendar and the dates on the records themselves.
            </Muted>
          </div>
          {proactive.map((p) => (
            <ProactiveCardView key={`${p.card.pack_domain}/${p.card.workflow_id}`} item={p} />
          ))}
        </div>
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

/**
 * A pack-scheduled card (Layer 5). Three things are stated plainly rather than
 * implied: WHY it is here (the pack's own copy, or an honest fallback when the
 * helper has not been verified yet), that it is queued if a quiet period is
 * holding it, and the autonomy ceiling it would run under.
 */
function ProactiveCardView({ item }: { item: ProactiveItem }) {
  const { card } = item;
  const queued = card.queued_until !== undefined;
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <SectionTitle>{card.workflow_name}</SectionTitle>
        <StatusPill tone={queued ? "muted" : "primary"}>
          {queued ? "Queued" : card.surface === "pre_close" ? "Pre-close" : "Due"}
        </StatusPill>
      </div>

      {card.copy ? (
        <p className="mt-1 text-xs text-ink">{card.copy}</p>
      ) : (
        // The pack's copy wanted something we will not invent — a match rate
        // before verification, or an account name the observer deliberately does
        // not emit. State the facts we DO have instead of a templated guess.
        <p className="mt-1 text-xs text-ink">
          {card.days_out !== undefined && card.reference_date
            ? `${card.days_out === 0 ? "Due today" : `${card.days_out} day${card.days_out === 1 ? "" : "s"} out`} — ${card.reference_date}. `
            : `${card.pack_domain} scheduled this for ${card.due_date}. `}
          {card.copy_missing.includes("account")
            ? "I read the date off the record but not who it belongs to, so I cannot name the account."
            : "I have not tested a helper against enough of your own runs to quote a match rate yet, so there is nothing to claim."}
        </p>
      )}

      {queued && (
        <Muted>
          Held until {card.queued_until}
          {card.quiet_period_label ? ` — ${card.quiet_period_label}` : ""}. Nothing is lost; it
          returns when the quiet period ends.
        </Muted>
      )}

      {card.ceiling && (
        <Muted>
          Would run at <span className="text-ink">{card.ceiling.replace(/_/g, " ")}</span> — pack
          policy caps it there, and only you can take it further.
        </Muted>
      )}
    </Card>
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
  // Same "what this actually is" line as a suggestion card: a workflow being
  // watched is just as opaque as one being offered if all you see is a name.
  const steps = stepPhrase(item.candidate.canonical_sequence);
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <SectionTitle>{item.title}</SectionTitle>
        <StatusPill tone="muted">Watching</StatusPill>
      </div>

      {steps && <p className="mt-1 text-sm text-ink">You {steps}.</p>}

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
  const [draftError, setDraftError] = useState<string | null>(null);
  const proposed = describeProposedHelper(rec.required_capabilities);
  const settings = useSettings((s) => s.settings);
  /** Replay numbers are only shown once enough runs exist for them to mean something. */
  const replayProven =
    v.runs_tested >= settings.verify_min_runs &&
    v.runs_tested > 0 &&
    v.runs_matched / v.runs_tested >= settings.verify_min_match_pct;
  const title = item.entry.custom_title ?? rec.title;
  // The observed step chain, in prose. Null when the tokens carry nothing worth
  // stating — better to omit the line than to pad the card.
  const steps = stepPhrase(item.candidate.canonical_sequence);
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
        {/* A template match is its own honest claim: recognized, counted — not
            "verified". The verified pill needs a replay score with enough runs
            behind it to mean something; at small N the verifier is
            self-referential and 2/2 would be noise dressed as proof. */}
        {rec.template && !replayProven ? (
          <StatusPill tone="primary">known workflow</StatusPill>
        ) : (
          <StatusPill tone="success">verified</StatusPill>
        )}
      </div>

      {/* WHAT THE WORKFLOW ACTUALLY IS. Without this the card only said how often
          it happened and how well a helper replayed — true, but it never told you
          which of your habits it meant. Built from the same canonical tokens the
          evidence list uses, so the two can never disagree. */}
      {steps && <p className="mt-1 text-sm text-ink">You {steps}.</p>}

      {rec.template ? (
        <>
          {/* The template claim — recognition + honest rep count. */}
          <p className="mt-1 text-sm text-ink">
            This matches <span className="font-semibold">{rec.template.workflow_name}</span> — a
            known {rec.template.pack_domain} workflow. Seen{" "}
            <span className="font-semibold tabular-nums">{rec.template.reps}</span>×
            {rec.template.cadence === "fiscal_monthly"
              ? " (distinct month-ends)"
              : rec.template.cadence === "weekly"
                ? " (distinct weeks)"
                : ""}
            .
          </p>
          {replayProven && (
            <p className="mt-1 text-sm text-ink">
              I also tested it against your last{" "}
              <span className="font-semibold tabular-nums">{v.runs_tested}</span> runs and matched{" "}
              <span className="font-semibold tabular-nums">{v.runs_matched}</span>.
            </p>
          )}
        </>
      ) : (
        /* The proof — every number here is a real replayed run. */
        <p className="mt-1 text-sm text-ink">
          I can do this for you — I tested it against your last{" "}
          <span className="font-semibold tabular-nums">{v.runs_tested}</span> runs and matched{" "}
          <span className="font-semibold tabular-nums">{v.runs_matched}</span>.
        </p>
      )}
      <Muted>
        ~{Math.round(rec.projected_minutes_saved_weekly)} min/week of repeated work, seen{" "}
        {rec.evidence.occurrence_count}× on {rec.evidence.distinct_day_count}{" "}
        {rec.evidence.distinct_day_count === 1 ? "day" : "days"}.
      </Muted>

      {/* What the helper would actually do — derived from the capabilities this
          pattern needs. Conditional wording: nothing is compiled until "Try it". */}
      {proposed.summary && (
        <>
          <p className="mt-1.5 text-sm text-ink">{proposed.summary}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {proposed.reads.length > 0 && (
              <StatusPill tone="muted">reads {proposed.reads.join(", ")}</StatusPill>
            )}
            <StatusPill tone={proposed.read_only ? "success" : "warning"}>
              {proposed.read_only ? "changes nothing" : `changes ${proposed.changes.join(", ")}`}
            </StatusPill>
            {!proposed.read_only && <StatusPill tone="primary">needs your approval</StatusPill>}
          </div>
        </>
      )}

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
              setDraftError(null);
              await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
              // The pattern's own derived intent selects the compiler recipe;
              // the legacy reconciliation intent stays the fallback.
              const created = await useAgents.getState().createDraft(
                item.candidate,
                rec.generalized_intent ?? "reconcile_account_list",
                rec.summary,
                title, // the exact workflow name on the card
              );
              await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });
              if (created.ok) {
                await act(item.signature, { type: "accepted" });
              } else {
                setDraftError(created.message);
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
      {draftError && <p className="mt-2 text-xs text-danger">{draftError}</p>}
      {item.entry.status === "accepted" && (
        <p className="mt-3 text-xs text-success">
          Draft agent created — inspect its full plan in the Agents tab. It drafts and stages only;
          every step needs your approval until its record says otherwise.
        </p>
      )}
    </Card>
  );
}
