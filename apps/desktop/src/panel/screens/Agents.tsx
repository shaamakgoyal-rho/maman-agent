import { useEffect, useState } from "react";
import { describeAgentSpec } from "@maman/agent-runtime";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { useAgents, type AgentRecord } from "../../lib/agents.js";
import { useRuns } from "../../lib/runs.js";
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
  const { agents, hydrated, hydrate, editDescription, setState } = useAgents();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated) return <Muted>Loading agents…</Muted>;

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
              v{latest.version_number} · {latest.spec.steps.length} steps · {described.limits} ·
              last run — · verified time 0 min · cost $0.00
            </p>

            {isOpen && (
              <div className="mt-2 space-y-2">
                <div>
                  <p className="text-xs font-medium text-ink">What this agent does</p>
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

      {runs.phase === "waiting_approval" && runs.pending && diff && (
        <div className="mt-2 card border-warning/40 bg-warning/5 p-2">
          <p className="text-xs font-medium">Approval required before any write</p>
          <p className="text-[11px] text-muted break-all">
            diff hash {runs.pending.diff_sha256.slice(0, 16)}… · {diff.summary.change_count} changes
            across {diff.summary.accounts_affected} accounts · destination Salesforce
          </p>
          <div className="mt-2 flex gap-2">
            <Button
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
              Approve &amp; write once
            </Button>
            <Button variant="secondary" onClick={() => void runs.reject()}>
              Reject
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
