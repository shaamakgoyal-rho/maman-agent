import { useEffect, useState } from "react";
import { useAgents, type AgentRecord } from "../../lib/agents.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";

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
        const isOpen = expanded === agent.agent_id;
        return (
          <Card key={agent.agent_id}>
            <div className="flex items-start justify-between gap-2">
              <SectionTitle>{agent.name}</SectionTitle>
              <StatusPill tone={STATE_TONE[agent.state]}>{agent.state}</StatusPill>
            </div>
            <Muted>{latest.spec.description}</Muted>
            <p className="mt-1 text-xs text-muted tabular-nums">
              v{latest.version_number} · {latest.spec.steps.length} steps · last run — · verified
              time 0 min · cost $0.00
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
              <Button variant="secondary" disabled>
                Run shadow (next milestone)
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
          </Card>
        );
      })}
    </div>
  );
}
