import { useEffect, useState } from "react";
import { describeAgentSpec } from "@maman/agent-runtime";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { useAgents, type AgentRecord } from "../../lib/agents.js";
import { agentRuntime, runAgentShadow } from "../../lib/agentService.js";
import { useRuns, type RunQuestion } from "../../lib/runs.js";
import { browserActuationOrigins } from "../../lib/browserRun.js";
import { useServerRuns } from "../../lib/serverRuns.js";
import { isTauri } from "../../lib/bridge.js";
import { useEnrollment } from "../../state/enrollment.js";
import { useSettings } from "../../state/settings.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";

/**
 * The candidate reruns recompile from: the REAL detected candidate stored at
 * creation, falling back to a minimal stand-in for records that predate it.
 */
function candidateFor(agent: AgentRecord): PatternCandidate {
  if (agent.source_candidate) return agent.source_candidate;
  return {
    pattern_id: agent.versions[0]!.spec.source_pattern_id,
    owner_user_id: agent.versions[0]!.spec.owner_user_id,
    first_seen_at: agent.created_at,
    last_seen_at: agent.created_at,
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 660_000,
    p90_duration_ms: 780_000,
    canonical_sequence: [],
    episode_ids: [],
    similarity_mean: 0.9,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 70,
    opportunity_score: 0.72,
    status: "eligible",
  };
}

/**
 * The one thing the agent could not find out by looking.
 *
 * It gets its own gate rather than a settings field, because the answer belongs
 * to THIS run: the agent has already opened the page, found the control, and
 * needs the single fact no page carries. Storing it would turn a one-off answer
 * into a standing instruction to write that value every time.
 *
 * The plan is shown above the box on purpose. A bare input asks someone to
 * supply a value without saying what it is for; with the plan they can see the
 * field it will go into and that exactly one line writes.
 */
function AnswerForm({
  questions,
  plan,
  error,
  onAnswer,
  onCancel,
}: {
  questions: RunQuestion[];
  plan: string[];
  error: string | null;
  onAnswer: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = questions.every((q) => (values[q.slot] ?? "").trim() !== "");

  return (
    <div className="mt-2 card border-primary/40 bg-primary/5 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink">
          I found the field. I need one thing from you.
        </p>
        <StatusPill tone="primary">nothing written yet</StatusPill>
      </div>

      {plan.length > 0 && (
        <ol className="mt-2 space-y-0.5 text-[11px] text-muted list-none">
          {plan.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}

      <form
        className="mt-2 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (complete) onAnswer(values);
        }}
      >
        {questions.map((q) => (
          <div key={q.slot}>
            <label className="text-xs font-medium text-ink" htmlFor={`answer-${q.slot}`}>
              {q.prompt}
            </label>
            <p className="text-[11px] text-muted">{q.detail}</p>
            <input
              id={`answer-${q.slot}`}
              // Never `type="password"` and never a stored credential field:
              // this value is typed into a page, so a secret must not be
              // encouraged here. `checkAnswer` refuses one that arrives anyway.
              type="text"
              autoComplete="off"
              value={values[q.slot] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [q.slot]: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-line bg-panel px-2 py-1 text-sm"
            />
          </div>
        ))}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={!complete}>
            Use this and continue
          </Button>
          <Button variant="secondary" type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * "Test agent" — the SAME runtime, in shadow. Not a separate fake test path:
 * this invokes the registered agent through the service, so what the user sees
 * here is exactly what a trigger firing would produce, minus the trigger.
 */
function TestAgentControl({ agentId }: { agentId: string }) {
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!agentRuntime().get(agentId)) return null;
  return (
    <div className="mt-1">
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const outcome = await runAgentShadow(agentId);
            setResult(
              outcome.status === "shadow_complete"
                ? `Shadow OK: ${outcome.steps_run} step(s), ${outcome.diff?.summary.change_count ?? 0} proposed change(s), nothing written.`
                : outcome.status === "needs_input"
                  ? `Needs you first: ${outcome.detail}`
                  : `Could not run: ${outcome.detail}`,
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Testing…" : "Test agent (shadow)"}
      </Button>
      {result && <p className="mt-1 text-[11px] text-muted">{result}</p>}
    </div>
  );
}

/** Agents: state, plain-language plan, immutable versions, budgets, controls. */

const STATE_TONE: Record<
  AgentRecord["state"],
  "muted" | "primary" | "success" | "warning" | "danger"
> = {
  draft: "muted",
  shadow: "primary",
  supervised: "warning",
  active: "success",
  paused: "muted",
  degraded: "danger",
  revoked: "danger",
  archived: "muted",
};

export function Agents() {
  const { agents, hydrated, hydrate, editDescription, setState, loadFailure, discarded } =
    useAgents();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated) return <Muted>Loading agents…</Muted>;

  // A FAILED LOAD IS NOT AN EMPTY ACCOUNT. Showing "No agents yet" here is what
  // made the loss invisible: the user saw a fresh-looking app, created
  // something, and the save replaced their real file. The store now refuses to
  // write while this is set, and this says why rather than leaving them to
  // discover it.
  if (loadFailure !== null) {
    return (
      <div className="card border-danger/40 bg-danger/5 p-3">
        <p className="text-sm font-medium text-ink">I could not read your saved agents</p>
        <p className="mt-1 text-xs text-muted">{loadFailure}</p>
        <p className="mt-2 text-xs text-muted">
          Your file has been left exactly as it is, and I will not save over it. Nothing here can be
          changed until it can be read — that is deliberate, because writing now would replace your
          agents with an empty list.
        </p>
      </div>
    );
  }

  const visible = agents.filter((a) => a.state !== "archived");

  if (visible.length === 0) {
    return (
      <EmptyState
        title="No agents yet"
        body="Accept a suggestion and click Create agent — the draft appears here with its full plan, and nothing runs until you say so."
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Records the file held that this build can no longer read. Salvage kept
          the rest, and the count is shown rather than swallowed — "you have 3
          agents" and "you have 3 and I dropped 2" are different statements. */}
      {discarded > 0 && (
        <p className="rounded-lg border border-warning/40 bg-warning/5 p-2 text-[11px] text-ink">
          {discarded} saved {discarded === 1 ? "agent" : "agents"} could not be read by this version
          and {discarded === 1 ? "is" : "are"} not shown. The others loaded normally.
        </p>
      )}
      {visible.map((agent) => {
        const latest = agent.versions[agent.versions.length - 1]!;
        const described = describeAgentSpec(latest.spec);
        const isOpen = expanded === agent.agent_id;
        return (
          <Card key={agent.agent_id}>
            <div className="flex items-start justify-between gap-2">
              <SectionTitle>{agent.name}</SectionTitle>
              <StatusPill tone={STATE_TONE[agent.state]}>{agent.state}</StatusPill>
            </div>
            {/* What it DOES (derived from the compiled spec), then why it exists. */}
            <p className="text-sm text-ink">{described.summary}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {described.reads.length > 0 && (
                <StatusPill tone="muted">reads {described.reads.join(", ")}</StatusPill>
              )}
              <StatusPill tone={described.read_only ? "success" : "warning"}>
                {described.read_only
                  ? "changes nothing"
                  : `changes ${described.changes.join(", ")}`}
              </StatusPill>
              {described.requires_approval && (
                <StatusPill tone="primary">needs your approval</StatusPill>
              )}
            </div>
            <Muted>Why: {latest.spec.description}</Muted>
            <p className="mt-1 text-xs text-muted tabular-nums">
              v{latest.version_number} · {latest.spec.steps.length} steps · {described.limits}
            </p>
            {/* The trigger and runtime history, from the persisted record —
                "last run —" used to be a literal dash regardless of history. */}
            <p className="text-xs text-muted tabular-nums">
              trigger:{" "}
              {latest.spec.trigger.type === "context"
                ? `when you work in ${latest.spec.trigger.app_category}${latest.spec.trigger.object_type ? ` on ${latest.spec.trigger.object_type} records` : ""}`
                : latest.spec.trigger.type}{" "}
              · last triggered{" "}
              {agent.last_triggered_at ? new Date(agent.last_triggered_at).toLocaleString() : "—"} ·
              last run {agent.last_run_at ? new Date(agent.last_run_at).toLocaleString() : "—"}
            </p>
            <TestAgentControl agentId={agent.agent_id} />

            {isOpen && (
              <div className="mt-2 space-y-2">
                {latest.intent_plan.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-ink">What this agent does</p>
                    <ol className="mt-1 space-y-0.5 text-xs text-muted list-none">
                      {latest.intent_plan.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ol>
                  </div>
                )}
                <div>
                  {/*
                   * Kept below the concrete plan, not replaced by it: this one
                   * is derived from the spec's own steps and budgets, so it is
                   * the account of what will actually execute. The plan above
                   * is the readable one; this is the checkable one.
                   */}
                  <p className="text-xs font-medium text-ink">
                    {latest.intent_plan.length > 0 ? "Steps and limits" : "What this agent does"}
                  </p>
                  <ol className="mt-1 space-y-0.5 text-xs text-muted list-none">
                    {latest.plain_language_plan.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <p className="text-xs font-medium text-ink">Permissions used</p>
                  <p className="text-xs text-muted">
                    {[...new Set(latest.spec.steps.map((s) => s.capability_id))].join(", ")}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-ink">Versions (immutable)</p>
                  <ul className="text-xs text-muted">
                    {agent.versions.map((v) => (
                      <li key={v.version_id} className="tabular-nums">
                        v{v.version_number} · {new Date(v.created_at).toLocaleString()} ·{" "}
                        {v.created_by}
                      </li>
                    ))}
                  </ul>
                </div>
                {editing === agent.agent_id ? (
                  <div className="flex gap-2">
                    <input
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      aria-label="New description"
                      className="flex-1 rounded-lg border border-line bg-panel px-2 py-1 text-xs"
                    />
                    <Button
                      onClick={async () => {
                        await editDescription(agent.agent_id, draftText);
                        setEditing(null);
                      }}
                    >
                      Save as new version
                    </Button>
                  </div>
                ) : (
                  <Muted>
                    Editing creates a new immutable version and returns the agent to shadow.
                  </Muted>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => setExpanded(isOpen ? null : agent.agent_id)}
              >
                {isOpen ? "Hide plan" : "Inspect plan"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(agent.agent_id);
                  setDraftText(latest.spec.description);
                  setExpanded(agent.agent_id);
                }}
              >
                Edit
              </Button>
              <Button variant="ghost" onClick={() => void setState(agent.agent_id, "archived")}>
                Archive
              </Button>
            </div>

            <RunPanel agent={agent} />
          </Card>
        );
      })}
    </div>
  );
}

function RunPanel({ agent }: { agent: AgentRecord }) {
  const localRuns = useRuns();
  const serverRuns = useServerRuns();
  const enrollment = useEnrollment();
  const { settings } = useSettings();
  const { registerOnServer } = useAgents();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Enrolled + server enabled → runs go through the durable server path.
  // Otherwise the local executor runs an explicit "local demo run".
  const serverMode = isTauri() && settings.server_enabled && enrollment.phase === "enrolled";
  const runs = serverMode ? serverRuns : localRuns;
  const diff = runs.diff;
  // Origins the user named for browser writes. Empty means the lane stays off.
  const actuationOrigins = browserActuationOrigins(settings.browser_actuation_origins);

  const start = async (mode: "shadow" | "supervised") => {
    setStartError(null);
    if (!serverMode) {
      if (mode === "shadow")
        await localRuns.startShadow(
          candidateFor(agent),
          agent.generalized_intent,
          agent.desired_outcome,
          agent.name,
        );
      else
        await localRuns.startSupervised(
          candidateFor(agent),
          agent.generalized_intent,
          agent.desired_outcome,
          agent.name,
        );
      return;
    }
    setStarting(true);
    const reg = await registerOnServer(agent.agent_id, candidateFor(agent));
    setStarting(false);
    if (!reg.ok) {
      setStartError(reg.message);
      return;
    }
    if (mode === "shadow") await serverRuns.startShadow(reg.server_agent_id);
    else await serverRuns.startSupervised(reg.server_agent_id);
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="mb-2 text-[11px] text-muted">
        {serverMode
          ? "Runs on the Maman server — durable, approval bound to step + diff hash."
          : "local demo run — runs in-app with the same safety semantics (no server)."}
      </p>
      {runs.phase === "idle" && (
        <div className="flex gap-2">
          <Button disabled={starting} onClick={() => void start("shadow")}>
            Run shadow
          </Button>
          <Button variant="secondary" disabled={starting} onClick={() => void start("supervised")}>
            Run supervised
          </Button>
        </div>
      )}

      {/* LANE. The API path is preferred and is the default; the browser path is
          for systems with no usable API. Choosing it is the user's decision, never
          an automatic fallback from a failed API write — a consequential step that
          fails stops and asks. Only offered when a site has been named for
          actuation, because without one there is nothing to check an origin against. */}
      {runs.phase === "idle" && !serverMode && "setLane" in localRuns && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-muted">Write via</span>
          <Button
            variant={localRuns.lane === "api" ? "primary" : "secondary"}
            onClick={() => localRuns.setLane("api")}
          >
            API
          </Button>
          <Button
            variant={localRuns.lane === "browser" ? "primary" : "secondary"}
            disabled={actuationOrigins.length === 0}
            onClick={() => localRuns.setLane("browser", actuationOrigins)}
          >
            Browser
          </Button>
          {actuationOrigins.length === 0 && (
            <span className="text-[11px] text-muted">
              add a site under Settings → browser actuation to enable
            </span>
          )}
        </div>
      )}
      {starting && <Muted>Registering this agent on the server…</Muted>}
      {startError && <p className="mt-1 text-xs text-danger">Could not start: {startError}</p>}

      {["running_read", "preparing_diff", "applying_write", "verifying"].includes(runs.phase) && (
        <Muted>
          {runs.phase === "running_read" && "Reading source data…"}
          {runs.phase === "preparing_diff" && "Preparing a proposed diff…"}
          {runs.phase === "applying_write" && "Applying the approved change…"}
          {runs.phase === "verifying" && "Verifying with an independent read…"}
        </Muted>
      )}

      {/* SAMPLE DATA, SAID OUT LOUD. The local runtime cannot read a file the
          user picked, so a reconciliation run here works off the bundled list.
          That used to happen silently — the adapter ignored its input and
          returned fixtures — and the resulting diff and ROI read as statements
          about the user's own records. */}
      {"sampleDataNotice" in runs && runs.sampleDataNotice && (
        <p className="mt-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-[11px] text-ink">
          {runs.sampleDataNotice}
        </p>
      )}

      {diff &&
        (runs.phase === "waiting_approval" ||
          runs.phase === "completed" ||
          runs.phase === "completed_with_warnings") && (
          <div className="mt-1">
            <p className="text-xs font-medium text-ink">
              Proposed diff — {diff.summary.confident_matches} confident,{" "}
              {diff.summary.ambiguous_skipped} ambiguous skipped, {diff.summary.missing} missing
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {diff.changes.map((c, i) => (
                <li key={i}>
                  <span className="font-medium">{c.account_name}</span> · {c.field}:{" "}
                  <span className="line-through">{c.old_value}</span> → {c.new_value}
                </li>
              ))}
            </ul>
          </div>
        )}

      {/* THE ONE QUESTION. Reached only after the agent has looked at the page
          and resolved everything it could for itself, so this asks for the
          single fact no page carries — not for the field, which it found. */}
      {runs.phase === "needs_input" && "questions" in runs && runs.questions.length > 0 && (
        <AnswerForm
          questions={runs.questions}
          plan={runs.questionPlan}
          error={runs.error}
          onAnswer={(answers) => void runs.answer(answers)}
          onCancel={() => runs.reset()}
        />
      )}

      {/* DOMAIN POLICY hold: the compliance beat. Not an approval the worker can
          pass — policy says this agent may not do this at all (SoD) or needs a
          second approver (dual control). Shown proudly: the cap is the feature. */}
      {"policyHold" in runs && runs.policyHold && (
        <div className="mt-2 card border-primary/40 bg-primary/5 p-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink">
              {runs.policyHold.kind === "segregation_of_duties"
                ? "Stopped by policy: a person must do this step"
                : "Stopped by policy: needs a second approver"}
            </p>
            <StatusPill tone="primary">policy</StatusPill>
          </div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
            {runs.policyHold.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {runs.policyHold.ceiling && (
            <p className="mt-1 text-[11px] text-muted">
              Autonomy ceiling for this workflow: {runs.policyHold.ceiling.replace(/_/g, " ")}.
            </p>
          )}
          <div className="mt-2">
            <Button variant="secondary" onClick={() => runs.reset()}>
              Done
            </Button>
          </div>
        </div>
      )}

      {runs.phase === "waiting_approval" && runs.pending && diff && (
        <div className="mt-2 card border-warning/40 bg-warning/5 p-2">
          <p className="text-xs font-medium">Approval required before any write</p>
          <p className="text-[11px] text-muted break-all">
            diff hash {runs.pending.diff_sha256.slice(0, 16)}… · {diff.summary.change_count} changes
            across {diff.summary.accounts_affected} accounts · destination Salesforce
          </p>

          {/* THE PLAN, for a browser-lane run. "Update 4 fields" is not something
              anyone can consent to when the mechanism is a real browser typing into
              a real page, so the exact ordered actions are what is shown. */}
          {"browserPlan" in runs && runs.browserPlan && (
            <div className="mt-2 rounded border border-line bg-surface p-2">
              <p className="text-[11px] font-medium text-ink">
                In the browser, on {runs.browserPlan.record} — {runs.browserPlan.writes} action
                {runs.browserPlan.writes === 1 ? "" : "s"} that change anything:
              </p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px] text-muted">
                {runs.browserPlan.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
              {runs.browserPlan.deferred > 0 && (
                <p className="mt-1 text-[11px] text-muted">
                  {runs.browserPlan.deferred} change
                  {runs.browserPlan.deferred === 1 ? " is" : "s are"} on other records (
                  {runs.browserPlan.deferred_records.join(", ")}) and will be left alone — the
                  browser acts on the page you have open.
                </p>
              )}
            </div>
          )}

          {/* A plan that could not be built blocks the gate rather than offering an
              approval that would fail on arrival. */}
          {"browserPlanRefusal" in runs && runs.browserPlanRefusal && (
            <p className="mt-2 text-[11px] text-danger">
              No browser plan: {runs.browserPlanRefusal}
            </p>
          )}

          <div className="mt-2 flex gap-2">
            <Button
              disabled={"browserPlanRefusal" in runs && Boolean(runs.browserPlanRefusal)}
              onClick={async () => {
                await runs.approve();
                // An approved run that COMPLETED counts toward earned autonomy.
                const phase = serverMode
                  ? useServerRuns.getState().phase
                  : useRuns.getState().phase;
                if (phase === "completed" || phase === "completed_with_warnings") {
                  await useAgents.getState().recordApprovedRun(agent.agent_id);
                }
              }}
            >
              {"browserPlan" in runs && runs.browserPlan
                ? "Approve & do it in the browser"
                : "Approve & write once"}
            </Button>
            <Button variant="secondary" onClick={() => void runs.reject()}>
              Reject
            </Button>
          </div>
        </div>
      )}

      {/* REVERT. Only offered when something was actually applied, and it is itself
          a consequential write that goes through the same gate — reverting is not an
          escape hatch from the rules the change was made under. */}
      {"revertable" in runs && runs.revertable.length > 0 && (
        <div className="mt-2 card border-line p-2">
          <p className="text-xs font-medium text-ink">
            {runs.revertable.length} change{runs.revertable.length === 1 ? "" : "s"} can be put back
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            Restores what the page held before, and refuses if someone has changed the field since.
          </p>
          <div className="mt-2">
            <Button variant="secondary" onClick={() => void localRuns.revert()}>
              Revert
            </Button>
          </div>
        </div>
      )}

      {runs.receiptSummary && (
        <div className="mt-2 card p-2">
          <p className="text-xs font-medium text-ink">{runs.receiptSummary}</p>
          {runs.receipt && (
            <p className="text-[11px] text-muted">
              ROI {runs.receipt.roi.savings_provenance} · verification{" "}
              {runs.receipt.steps.some((s) => s.verification === "independent_read_passed")
                ? "passed"
                : runs.mode === "shadow"
                  ? "n/a (shadow)"
                  : "—"}
            </p>
          )}
          <Button variant="ghost" onClick={() => runs.reset()}>
            Done
          </Button>
        </div>
      )}

      {runs.phase === "cancelled" && (
        <div className="mt-2">
          <Muted>Run cancelled — nothing was written.</Muted>
          <Button variant="ghost" onClick={() => runs.reset()}>
            Done
          </Button>
        </div>
      )}
      {runs.phase === "failed" && (
        <div className="mt-2">
          <p className="text-xs text-danger">Run stopped safely: {runs.error}</p>
          <Button variant="ghost" onClick={() => runs.reset()}>
            Done
          </Button>
        </div>
      )}

      <AutonomyMeter agent={agent} />
    </div>
  );
}

/**
 * Earned autonomy, made visible. Each approved + completed supervised run
 * ticks the meter; when it fills, the WORKER may grant draft autonomy —
 * nothing is ever auto-promoted from a score.
 */
function AutonomyMeter({ agent }: { agent: AgentRecord }) {
  const { settings } = useSettings();
  const { grantDraftAutonomy } = useAgents();
  const needed = settings.autonomy_min_approved_runs;
  const done = agent.approved_runs;
  const remaining = Math.max(0, needed - done);

  if (agent.draft_autonomy) {
    return (
      <p className="mt-3 border-t border-line pt-2 text-[11px] text-success">
        Draft autonomy granted — Maman may prepare drafts for this workflow without asking first.
        Material writes still require your approval, always.
      </p>
    );
  }
  return (
    <div className="mt-3 border-t border-line pt-2">
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          {remaining > 0
            ? `${remaining} more approved run${remaining === 1 ? "" : "s"} until Maman can draft without asking`
            : "Earned: you can now let Maman draft without asking"}
        </span>
        <span className="tabular-nums">
          {Math.min(done, needed)}/{needed}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-success transition-all"
          style={{ width: `${Math.min(100, Math.round((done / needed) * 100))}%` }}
        />
      </div>
      {remaining === 0 && (
        <Button variant="secondary" onClick={() => void grantDraftAutonomy(agent.agent_id)}>
          Grant draft autonomy
        </Button>
      )}
    </div>
  );
}

void uuidv7;
