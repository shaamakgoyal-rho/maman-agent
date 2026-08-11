import { useEffect, useState } from "react";
import { useSettings, pauseUntil } from "../../state/settings.js";
import { useRecommendations, type RecommendationWithState } from "../../lib/recommendations.js";
import { createAgentAndActivate, useAgentService } from "../../lib/agentService.js";
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
 *  - Create agent is ONE click into the one authoritative creation function
 *    (`createAgentAndActivate`), which compiles → persists → registers →
 *    installs the trigger → shadow-runs. This screen adds no second path.
 */
export function Mother({ petState }: { petState: PetStateName }) {
  const { settings, update } = useSettings();
  const { items, forming, hydrated, refresh, act } = useRecommendations();
  const { creation, staged } = useAgentService();
  const agents = useAgents((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const [barError, setBarError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

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
      // A refusal is stated where the user asked for the thing, in the words the
      // runtime used. No navigation into an editor: the click was "do this", and
      // an honest "I can't, because X" respects that better than a form.
      setFailure(created.message);
    } finally {
      setBusy(false);
    }
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
          {creation.length > 0 && (
            <p className="mt-2 text-xs text-muted">{creation[creation.length - 1]!.detail}</p>
          )}
          {failure && <p className="mt-2 text-xs text-danger">{failure}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void create(top)} disabled={busy}>
              {busy ? "Creating…" : "Create agent"}
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

      {/* ----------------------------------------------- what it did recently */}
      {staged.length > 0 && (
        <Card>
          <SectionTitle>Recently, for you</SectionTitle>
          <ul className="space-y-1.5">
            {staged.slice(0, 4).map((run) => (
              <li key={run.staged_id} className="flex items-start justify-between gap-2 text-sm">
                <span className="font-medium">{run.agent_name}</span>
                <span className="text-right text-xs text-muted">
                  {run.outcome.kind === "shadow"
                    ? "Practised it — nothing changed"
                    : run.outcome.kind === "needs_input"
                      ? "Needs one answer from you"
                      : run.outcome.kind === "failed"
                        ? run.outcome.detail
                        : "Ready when you are"}
                </span>
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
