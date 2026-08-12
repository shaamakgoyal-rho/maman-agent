import { useEffect, useState } from "react";
import { useSettings, pauseUntil } from "../../state/settings.js";
import { useRecommendations, type RecommendationWithState } from "../../lib/recommendations.js";
import {
  answerStagedRun,
  approveStagedRun,
  createAgentAndActivate,
  grantOriginAndRetry,
  useAgentService,
} from "../../lib/agentService.js";
import { useAgents } from "../../lib/agents.js";
import { setSubtitleBarVisible } from "../../lib/statusbar.js";
import { Button, Card, Muted, SectionTitle, StatusPill } from "../ui.js";
import { PET_STATE_DESCRIPTIONS } from "../../pet/renderer.js";
import type { PetStateName } from "../../pet/machine.js";

/**
 * THE MOTHER SURFACE — the product's primary (and usually only) destination.
 *
 * What Maman is doing, the ONE best thing it noticed, what it has done for the
 * user lately, and nothing else. This replaces the Home + Suggestions pair,
 * whose combined surface exposed the implementation instead of the product:
 * new/snoozed/accepted/dismissed filters, a pipeline legend, "forming"
 * candidates, replay-evidence tables, compiler internals and demo seeding.
 *
 * The rules this screen is built on:
 *  - ONE suggestion at a time. A queue of automation offers is a backlog, and a
 *    backlog is the opposite of a mother noticing something for you.
 *  - Plain language. The card says what repeats, how often, and what Maman can
 *    do — never "candidate", "opportunity score", "replay", or "lane".
 *  - Evidence on demand, not by default: everything technical lives behind
 *    "Why this?", so a curious user can audit it and nobody else pays for it.
 *  - "Automate this" is ONE click into the one authoritative creation function
 *    (`createAgentAndActivate`), which compiles → persists → registers →
 *    installs the trigger → shadow-runs. This screen adds no second path, and
 *    the standard journey never says "agent" or shows a builder form.
 */
export function Mother({ petState }: { petState: PetStateName }) {
  const { settings, update } = useSettings();
  const { items, forming, hydrated, refresh, act } = useRecommendations();
  const { creation, staged } = useAgentService();
  const agents = useAgents((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const [demo, setDemo] = useState<{ steps: DemoStep[]; active: number } | null>(null);
  const [barError, setBarError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Creation paused on ONE inline question: may Maman act on this origin? */
  const [consent, setConsent] = useState<{ origin: string; item: RecommendationWithState } | null>(
    null,
  );
  /** Inline answers being typed for a staged run's missing inputs. */
  const [stagedAnswers, setStagedAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const paused = settings.observation_paused;
  // ONE suggestion: the freshest thing Maman has not been told to ignore.
  const top: RecommendationWithState | undefined = items.find((i) => i.entry.status === "new");
  const liveAgents = agents.filter((a) => a.state !== "archived" && a.state !== "revoked");

  const create = async (item: RecommendationWithState) => {
    setBusy(true);
    setFailure(null);
    try {
      const rec = item.recommendation;
      // `generalized_intent` is optional on the contract, and an intent-less
      // card cannot be compiled into anything real — say so rather than calling
      // the creation function with a fabricated intent.
      if (!rec.generalized_intent) {
        setFailure("Maman has not worked out what this routine is for yet.");
        return;
      }
      const created = await createAgentAndActivate(
        item.candidate,
        rec.generalized_intent,
        rec.summary,
        item.entry.custom_title ?? rec.title,
      );
      if (created.ok) {
        await act(item.signature, { type: "accepted" });
        return;
      }
      // ONE inline question instead of a trip to Privacy: the workflow names
      // its own site, and consent for exactly that site continues the flow.
      if ("needs_permission" in created) {
        setConsent({ origin: created.needs_permission.origin, item });
        return;
      }
      // A refusal is stated where the user asked for the thing, in the words the
      // runtime used. No navigation into an editor: the click was "do this", and
      // an honest "I can't, because X" respects that better than a form.
      setFailure(created.message);
    } finally {
      setBusy(false);
    }
  };

  const grantConsent = async () => {
    if (!consent) return;
    const { origin, item } = consent;
    setConsent(null);
    setBusy(true);
    setFailure(null);
    try {
      const rec = item.recommendation;
      const created = await grantOriginAndRetry(
        origin,
        item.candidate,
        rec.generalized_intent ?? "automate_record_workflow",
        rec.summary,
        item.entry.custom_title ?? rec.title,
      );
      if (created.ok) {
        await act(item.signature, { type: "accepted" });
        return;
      }
      setFailure(created.message);
    } finally {
      setBusy(false);
    }
  };

  const showDemo = (item: RecommendationWithState) => {
    setDemo({ steps: demoSteps(item), active: 0 });
  };

  return (
    <div className="space-y-3">
      {/* ---------------------------------------------------- what I'm doing */}
      <Card>
        <div className="flex items-center justify-between">
          <SectionTitle>{paused ? "Paused" : "Watching your work"}</SectionTitle>
          <StatusPill tone={paused ? "muted" : "success"}>
            {paused ? "Paused" : "Observing"}
          </StatusPill>
        </div>
        <Muted>{PET_STATE_DESCRIPTIONS[petState]}</Muted>
        <div className="mt-3 flex flex-wrap gap-2">
          {paused ? (
            <Button onClick={() => void update({ observation_paused: false, paused_until: null })}>
              Resume
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil(15) })}
              >
                Pause 15 min
              </Button>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil(60) })}
              >
                Pause 1 hour
              </Button>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil("tomorrow") })}
              >
                Until tomorrow
              </Button>
            </>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              void setSubtitleBarVisible(!settings.statusbar_enabled, update).then((r) =>
                setBarError(r.ok ? null : r.detail),
              );
            }}
          >
            {settings.statusbar_enabled ? "Hide the bar" : "Show the bar"}
          </Button>
        </div>
        {barError && <p className="mt-1 text-xs text-danger">{barError}</p>}
      </Card>

      {/* ------------------------------------------------- the one suggestion */}
      {top ? (
        <Card>
          <SectionTitle>{top.entry.custom_title ?? top.recommendation.title}</SectionTitle>
          <p className="mt-1 text-sm">{top.recommendation.summary}</p>
          {/* Outcome-first: the evidence and the time it saves, in plain words,
              ON the card — not hidden behind "Why this?". A nontechnical user
              decides from this line, never from a builder form. */}
          <p className="mt-2 text-xs text-muted">
            Seen {top.candidate.occurrence_count}× across {top.candidate.distinct_day_count}{" "}
            {top.candidate.distinct_day_count === 1 ? "day" : "days"}
            {top.recommendation.projected_minutes_saved_weekly >= 1
              ? ` · saves about ${Math.round(top.recommendation.projected_minutes_saved_weekly)} min a week`
              : ""}
          </p>
          {creation.length > 0 && (
            <p className="mt-2 text-xs text-muted" role="status" aria-live="polite">
              {creation[creation.length - 1]!.detail}
            </p>
          )}
          {failure && (
            <p className="mt-2 text-xs text-danger" role="status" aria-live="polite">
              {failure}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void create(top)} disabled={busy}>
              {busy ? "Setting it up…" : "Automate this"}
            </Button>
            <Button variant="secondary" onClick={() => showDemo(top)} disabled={busy}>
              Demo run
            </Button>
            <Button
              variant="secondary"
              onClick={() => void act(top.signature, { type: "snoozed", option: "1w" })}
              disabled={busy}
            >
              Not now
            </Button>
            <Button
              variant="secondary"
              onClick={() => void act(top.signature, { type: "never_suggest" })}
              disabled={busy}
            >
              Never suggest this
            </Button>
          </div>
          {demo && (
            <AutomationDemo
              steps={demo.steps}
              active={demo.active}
              onStep={(active) => setDemo((current) => (current ? { ...current, active } : null))}
              onClose={() => setDemo(null)}
            />
          )}
          {/* Evidence is auditable but not in the way — the technical case for
              the suggestion, only for someone who asks for it. */}
          <button
            className="mt-3 text-xs text-primary"
            onClick={() => setWhy((v) => !v)}
            aria-expanded={why}
          >
            {why ? "Hide details" : "Why this?"}
          </button>
          {why && (
            <div className="mt-2 space-y-1 border-t border-line pt-2 text-xs text-muted">
              <p>
                Seen {top.candidate.occurrence_count}× across {top.candidate.distinct_day_count}{" "}
                {top.candidate.distinct_day_count === 1 ? "day" : "days"}; median run{" "}
                {Math.round(top.candidate.median_duration_ms / 60_000)} min.
              </p>
              <p>
                Tested against {top.verification.runs_tested} of your own runs, matched{" "}
                {top.verification.runs_matched}.
              </p>
              <p>
                Steps:{" "}
                {top.recommendation.evidence.redacted_steps
                  .map((step) => `${step.action} ${step.app}`)
                  .join(" → ")}
              </p>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <SectionTitle>Nothing to suggest yet</SectionTitle>
          <Muted>
            {paused
              ? "Observation is paused, so Maman is not learning anything right now."
              : hydrated && forming.length > 0
                ? `Maman is watching ${forming.length} repeated ${forming.length === 1 ? "routine" : "routines"}. It speaks up once one is stable enough to automate.`
                : "Maman speaks up as soon as it sees you repeat something it can take over."}
          </Muted>
        </Card>
      )}

      {/* ------------------------------------ one inline permission question */}
      {consent && (
        <Card>
          <SectionTitle>One permission</SectionTitle>
          <p className="text-sm">
            Allow Maman to act on <span className="font-mono">{consent.origin}</span>?
          </p>
          <Muted>
            Permission applies only to that site. Maman still shows every change before anything is
            written, and never touches password, payment or one-time-code fields.
          </Muted>
          <div className="mt-2 flex gap-2">
            <Button onClick={() => void grantConsent()} disabled={busy}>
              Allow this site
            </Button>
            <Button variant="secondary" onClick={() => setConsent(null)}>
              Not now
            </Button>
          </div>
        </Card>
      )}

      {/* ------------------------- proposals, questions, approvals, receipts */}
      {staged.length > 0 && (
        <Card>
          <SectionTitle>Recently, for you</SectionTitle>
          <ul className="space-y-2">
            {staged.slice(0, 4).map((run) => (
              <li key={run.staged_id} className="rounded-md border border-line p-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{run.agent_name}</span>
                  <span className="text-right text-xs text-muted">
                    {run.outcome.kind === "shadow"
                      ? "Practised it — nothing changed yet"
                      : run.outcome.kind === "needs_input"
                        ? "Needs one answer from you"
                        : run.outcome.kind === "executing"
                          ? "Doing it now…"
                          : run.outcome.kind === "completed"
                            ? run.outcome.verified
                              ? "Done, and read back to confirm"
                              : "Done — see what was and wasn't confirmed"
                            : run.outcome.kind === "stale"
                              ? "The page changed — review again"
                              : run.outcome.kind === "failed"
                                ? run.outcome.detail
                                : "Ready when you are"}
                  </span>
                </div>

                {/* The exact proposed changes, and the approval that binds to them. */}
                {(run.outcome.kind === "shadow" || run.outcome.kind === "stale") &&
                  run.outcome.diff &&
                  run.outcome.diff.changes.length > 0 && (
                    <div className="mt-2">
                      <ul className="space-y-0.5 font-mono text-xs">
                        {run.outcome.diff.changes.slice(0, 6).map((change, i) => (
                          <li key={i}>
                            {change.field}: “{change.old_value}” → “{change.new_value}”
                          </li>
                        ))}
                      </ul>
                      {run.outcome.sha && (
                        <div className="mt-2 flex items-center gap-2">
                          <Button onClick={() => void approveStagedRun(run.staged_id)}>
                            Approve &amp; do it
                          </Button>
                          <span className="text-[10px] text-muted">
                            approves exactly {run.outcome.sha.slice(0, 12)}…
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                {/* The one inline question, answered where it was asked. */}
                {run.outcome.kind === "needs_input" && run.outcome.missing.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {run.outcome.missing.map((m) => (
                      <label key={m.key} className="block text-xs">
                        <span className="text-muted">{m.label}</span>
                        <input
                          className="mt-0.5 w-full rounded border border-line bg-bg px-2 py-1 text-sm"
                          value={stagedAnswers[`${run.staged_id}:${m.key}`] ?? ""}
                          onChange={(e) =>
                            setStagedAnswers((s) => ({
                              ...s,
                              [`${run.staged_id}:${m.key}`]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                    <Button
                      variant="secondary"
                      onClick={() => {
                        const missing =
                          run.outcome.kind === "needs_input" ? run.outcome.missing : [];
                        const answers = Object.fromEntries(
                          missing
                            .map((m) => [m.key, stagedAnswers[`${run.staged_id}:${m.key}`] ?? ""])
                            .filter(([, v]) => v !== ""),
                        );
                        void answerStagedRun(run.staged_id, answers);
                      }}
                    >
                      Use this
                    </Button>
                  </div>
                )}

                {run.outcome.kind === "completed" && (
                  <p className="mt-1 text-xs text-muted">{run.outcome.verify_detail}</p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {liveAgents.length > 0 && (
        <Card>
          <SectionTitle>What I've learned</SectionTitle>
          <Muted>
            {liveAgents.length} {liveAgents.length === 1 ? "agent" : "agents"} watching for their
            moment. See Agents for what each one does.
          </Muted>
        </Card>
      )}
    </div>
  );
}

type DemoStep = {
  label: string;
  detail: string;
  action: "focus" | "fill" | "click" | "read";
};

function demoSteps(item: RecommendationWithState): DemoStep[] {
  const fromSequence = item.candidate.canonical_sequence
    .map((token) => {
      const [, category, event, role, semantic, object] = token.split(":");
      const target = [semantic, role].filter((v) => v && v !== "-").join(" ");
      const context = [category, object].filter((v) => v && v !== "-").join(" / ");
      if (event?.includes("value_committed")) {
        return { label: `Fill ${target || "field"}`, detail: context, action: "fill" as const };
      }
      if (event?.includes("click") || event?.includes("press") || event?.includes("submit")) {
        return { label: `Click ${target || "control"}`, detail: context, action: "click" as const };
      }
      if (event?.includes("focused") || event?.includes("focus")) {
        return { label: `Focus ${target || "field"}`, detail: context, action: "focus" as const };
      }
      return { label: `Read ${target || "page"}`, detail: context, action: "read" as const };
    })
    .filter((step) => step.detail || step.label);

  if (fromSequence.length > 0) return fromSequence.slice(0, 6);

  return item.recommendation.evidence.redacted_steps.slice(0, 6).map((step) => ({
    label: step.action,
    detail: step.app,
    action: step.action.toLowerCase().includes("click") ? "click" : "read",
  }));
}

export function __demoStepsForTests(item: RecommendationWithState): DemoStep[] {
  return demoSteps(item);
}

function AutomationDemo({
  steps,
  active,
  onStep,
  onClose,
}: {
  steps: DemoStep[];
  active: number;
  onStep: (step: number) => void;
  onClose: () => void;
}) {
  // The walkthrough plays itself: the cursor advances a step at a time until
  // the last one, and clicking a step jumps there (playback continues from
  // it). Reduced motion turns autoplay off — the steps are still clickable,
  // and nothing depends on the animation to be understood.
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (active >= steps.length - 1) return;
    const timer = setTimeout(() => onStep(active + 1), 1600);
    return () => clearTimeout(timer);
  }, [active, steps.length, onStep]);

  const current = steps[active] ?? steps[0];
  const points = [
    { left: "26%", top: "38%" },
    { left: "70%", top: "40%" },
    { left: "68%", top: "68%" },
    { left: "36%", top: "66%" },
    { left: "78%", top: "76%" },
    { left: "48%", top: "48%" },
  ];
  const point = points[active % points.length]!;

  return (
    <div className="mt-3 rounded-lg border border-line bg-bg-soft p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Demo run</p>
          <p className="text-xs text-muted">
            A dry preview of what the agent will target. Nothing touches your browser.
          </p>
        </div>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[1.2fr_0.8fr]">
        <div className="relative h-44 overflow-hidden rounded-lg border border-line bg-white">
          <div className="flex h-7 items-center gap-1 border-b border-line bg-bg-soft px-2">
            <span className="h-2 w-2 rounded-full bg-danger" />
            <span className="h-2 w-2 rounded-full bg-warning" />
            <span className="h-2 w-2 rounded-full bg-success" />
            <span className="ml-2 h-3 flex-1 rounded bg-line" />
          </div>
          <div className="grid grid-cols-2 gap-3 p-4">
            <div className="h-8 rounded border border-line bg-bg-soft" />
            <div className="h-8 rounded border border-line bg-bg-soft" />
            <div className="h-8 rounded border border-line bg-bg-soft" />
            <div className="h-8 rounded border border-primary bg-primary/10" />
            <div className="col-span-2 h-8 rounded border border-line bg-bg-soft" />
            <div className="h-8 rounded bg-primary/80" />
          </div>
          <div
            className="absolute h-5 w-5 transition-all duration-300"
            style={{ left: point.left, top: point.top }}
            aria-hidden="true"
          >
            <div className="h-0 w-0 border-l-[10px] border-r-[4px] border-t-[18px] border-l-ink border-r-transparent border-t-transparent drop-shadow" />
            {current?.action === "click" && (
              <span className="absolute -left-2 -top-2 h-7 w-7 rounded-full border border-primary" />
            )}
          </div>
        </div>
        <ol className="space-y-1.5">
          {steps.map((step, index) => (
            <li key={`${step.label}-${index}`}>
              <button
                className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                  index === active ? "border-primary bg-primary/10" : "border-line bg-bg"
                }`}
                onClick={() => onStep(index)}
              >
                <span className="font-medium">
                  {index + 1}. {step.label}
                </span>
                {step.detail && <span className="block text-muted">{step.detail}</span>}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
