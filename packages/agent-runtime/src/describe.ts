import { getCapability } from "@maman/capability-catalog";
import type { AgentSpec } from "@maman/contracts";

/**
 * Plain-language description of what an agent DOES, derived deterministically
 * from its compiled spec. Distinct from `spec.description`, which explains why
 * the agent exists (the observed pattern); this answers "what will it do to my
 * data?" — what it reads, what it changes, where, and whether it needs
 * approval first.
 *
 * Pure and deterministic: every claim traces to a step's capability + mode, so
 * the UI can never overstate an agent's reach. A model may rewrite this copy
 * but may never change what it reports (spec §13).
 */

const CONNECTOR_LABELS: Record<string, string> = {
  salesforce: "Salesforce",
  google_sheets: "Google Sheets",
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  browser: "the browser",
  local: "your own files",
};

export type AgentDescription = {
  /** One or two sentences: the whole job, in order. */
  summary: string;
  /** Where it reads from (human labels, deduped, in step order). */
  reads: string[];
  /** What it changes (empty = read-only, changes nothing anywhere). */
  changes: string[];
  /** Whether a material write pauses for explicit human approval. */
  requires_approval: boolean;
  /** Whether the agent can write at all. */
  read_only: boolean;
  /** Compact limits fragment (records, cost, runtime) — no trailing period, so
   * it composes into a separator-joined metadata line. */
  limits: string;
};

function connectorLabel(capabilityId: string): string | null {
  const capability = getCapability(capabilityId);
  if (!capability) return null;
  return CONNECTOR_LABELS[capability.connector] ?? capability.connector;
}

/** Joins labels as an English list: "a", "a and b", "a, b and c". */
function humanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function describeAgentSpec(spec: AgentSpec): AgentDescription {
  const ordered = [...spec.steps].sort((a, b) => a.order - b.order);

  const reads: string[] = [];
  const changes: string[] = [];
  let proposes = false;
  let requiresApproval = false;

  for (const step of ordered) {
    const label = connectorLabel(step.capability_id);
    if (!label) continue;
    if (step.mode === "read" && !reads.includes(label)) reads.push(label);
    if (step.mode === "propose_write") proposes = true;
    if (step.mode === "write") {
      if (!changes.includes(label)) changes.push(label);
      if (step.approval.required) requiresApproval = true;
    }
  }

  const readOnly = changes.length === 0;
  const parts: string[] = [];

  if (spec.inputs.length > 0) {
    parts.push(`You give it ${humanList(spec.inputs.map((i) => i.label.toLowerCase()))}`);
  }
  if (reads.length > 0) {
    parts.push(`${parts.length ? "it reads" : "It reads"} ${humanList(reads)}`);
  }
  if (proposes) {
    parts.push("shows you exactly what would change");
  }
  if (!readOnly) {
    const approval = requiresApproval ? "and only after you approve" : "and then";
    parts.push(
      `${approval} updates ${humanList(changes)} — at most ${spec.budgets.max_records_written} records`,
    );
  }

  let summary = parts.length > 0 ? `${parts.join(", ")}.` : "";
  if (readOnly) {
    summary += summary
      ? " It never changes anything."
      : "This agent only reads; it never changes anything.";
  }

  const limits =
    `max ${spec.budgets.max_records_written} records, ` +
    `$${spec.budgets.max_cost_usd.toFixed(2)}, ` +
    `${Math.round(spec.budgets.max_runtime_seconds / 60)} min per run`;

  return {
    summary,
    reads,
    changes,
    requires_approval: requiresApproval,
    read_only: readOnly,
    limits,
  };
}

/**
 * Description of a helper Maman is PROPOSING, before anything is compiled.
 *
 * At suggestion time no AgentSpec exists yet — the spec is only built when the
 * worker accepts ("Try it") — so this derives from the pattern's required
 * capabilities instead, and speaks in the conditional ("would") because nothing
 * is committed. It deliberately reports LESS certainty than
 * `describeAgentSpec`: no record/cost limits are claimed, since those are set at
 * compile time.
 *
 * The approval claim is safe rather than optimistic: the compiler marks every
 * write step approval-required and the policy engine independently requires
 * approval for material writes, so a write-capable capability always implies an
 * approval gate. `writes_need_approval_is_guaranteed` in the tests pins that.
 */
export type ProposedHelperDescription = {
  /** One sentence in the conditional: what the helper would do if accepted. */
  summary: string;
  /** Where it would read from. */
  reads: string[];
  /** What it could change (empty = it could only read). */
  changes: string[];
  /** Whether it would ever change anything. */
  read_only: boolean;
};

export function describeProposedHelper(capabilityIds: string[]): ProposedHelperDescription {
  const reads: string[] = [];
  const changes: string[] = [];

  for (const id of capabilityIds) {
    const capability = getCapability(id);
    if (!capability) continue;
    const label = CONNECTOR_LABELS[capability.connector] ?? capability.connector;
    // A capability that can write is reported as a change; everything else reads.
    if (capability.supported_modes.includes("write")) {
      if (!changes.includes(label)) changes.push(label);
    } else if (!reads.includes(label)) {
      reads.push(label);
    }
  }

  const readOnly = changes.length === 0;
  if (reads.length === 0 && readOnly) {
    return { summary: "", reads, changes, read_only: true };
  }

  const parts: string[] = [];
  if (reads.length > 0) parts.push(`read ${humanList(reads)}`);
  parts.push(
    readOnly
      ? "and change nothing at all"
      : `show you every change first, then — only with your approval — update ${humanList(changes)}`,
  );
  return {
    summary: `It would ${parts.join(", ")}.`,
    reads,
    changes,
    read_only: readOnly,
  };
}
