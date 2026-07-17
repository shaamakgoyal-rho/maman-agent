import { EmptyState } from "../ui.js";

/** Real data flows arrive with their milestones (M5 suggestions, M6/M7 agents). */

export function Agents() {
  return (
    <EmptyState
      title="No agents yet"
      body="When you accept a suggestion, its draft agent lives here with plain-language steps, versions, permissions, budgets, run history, and verified ROI. Drafts never activate silently."
    />
  );
}
