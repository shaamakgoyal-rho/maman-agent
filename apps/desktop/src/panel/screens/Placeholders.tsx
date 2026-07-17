import { EmptyState } from "../ui.js";

/** Real data flows arrive with their milestones (M3 activity, M5 suggestions, M6/M7 agents). */

export function Suggestions() {
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5" role="tablist" aria-label="Suggestion filters">
        {["New", "Snoozed", "Accepted", "Dismissed"].map((filter, i) => (
          <button
            key={filter}
            role="tab"
            aria-selected={i === 0}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              i === 0 ? "bg-primary text-white" : "bg-panel border border-line text-muted"
            }`}
          >
            {filter}
          </button>
        ))}
      </div>
      <EmptyState
        title="No suggestions yet"
        body="Suggestions appear after Maman notices a workflow repeat at least three times across two days, with evidence, projected value, cost, and risk — and never more than your daily budget."
      />
    </div>
  );
}

export function Agents() {
  return (
    <EmptyState
      title="No agents yet"
      body="When you accept a suggestion, its draft agent lives here with plain-language steps, versions, permissions, budgets, run history, and verified ROI. Drafts never activate silently."
    />
  );
}

export function Activity() {
  return (
    <EmptyState
      title="Nothing recorded yet"
      body="Once observation is on, 'What Maman saw' shows a human-readable local timeline here — and you can delete any event, episode, app history, or everything."
    />
  );
}
