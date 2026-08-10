import type { AgentSpec } from "@maman/contracts";

/**
 * REQUIRED INPUTS MUST ACTUALLY ARRIVE.
 *
 * `resolveStepInputs` binds an `agent_input` step input with
 * `resolved[name] = agentInputs[binding.ref]`. When nothing supplied that key
 * the result is `undefined`, silently, and the step runs anyway. What happens
 * next depends entirely on the adapter, and the two live cases were both bad:
 *
 * - `local.parse_csv` is `read: async () => structuredClone(DEMO_CSV_ROWS)` —
 *   it ignores its inputs. The reconciliation spec declares `account_csv` as a
 *   REQUIRED user input, the desktop passed `{}`, and the run reconciled
 *   FIXTURE ROWS, produced a diff, and published a receipt with ROI. Nobody was
 *   told the account list they never provided had been substituted.
 * - The browser read adapter threw "No fields were configured to read. Teach
 *   the workflow which fields matter first." — an accurate complaint about an
 *   unbound input, surfacing as a mid-run failure that reads like a missing
 *   feature. One instance of it fired AFTER a write, from the verification
 *   step, so the run wrote and then failed to prove it.
 *
 * Those are the same defect: a declared requirement that nothing enforces. This
 * module makes it a typed, pre-execution answer, in the same shape as
 * `validateRuntimeCapabilities` — checked once, before any step, so a run that
 * cannot satisfy its own spec never starts rather than stopping half way.
 */

export type MissingInput = {
  key: string;
  /** The user-facing label from the spec, so a message can name it. */
  label: string;
  /** Where it was supposed to come from. Drives what the user is told to do. */
  source: AgentSpec["inputs"][number]["source"];
  reason: "not_supplied" | "empty";
};

export type InputReadiness = { ready: true } | { ready: false; missing: MissingInput[] };

/**
 * Which required inputs this run cannot satisfy.
 *
 * Only `required` inputs are checked. An optional input that is absent is
 * absent on purpose, and `undefined` is its correct resolved value.
 *
 * An input supplied as `null`, `""`, or an empty array counts as MISSING rather
 * than as an answer. That is not pedantry: an empty array is exactly what the
 * browser read adapter received when discovery had not run, and treating it as
 * "supplied" is what let the run continue to the point of throwing.
 */
export function validateAgentInputs(
  spec: AgentSpec,
  agentInputs: Readonly<Record<string, unknown>>,
): InputReadiness {
  const missing: MissingInput[] = [];
  for (const input of spec.inputs) {
    if (!input.required) continue;
    const supplied = agentInputs[input.key];
    if (supplied === undefined || supplied === null) {
      missing.push({
        key: input.key,
        label: input.label,
        source: input.source,
        reason: "not_supplied",
      });
      continue;
    }
    const empty =
      (typeof supplied === "string" && supplied.trim() === "") ||
      (Array.isArray(supplied) && supplied.length === 0);
    if (empty) {
      missing.push({ key: input.key, label: input.label, source: input.source, reason: "empty" });
    }
  }
  return missing.length === 0 ? { ready: true } : { ready: false, missing };
}

/**
 * What to tell the user, in terms of who is supposed to supply the thing.
 *
 * The source matters to the reader: "you need to give me X" and "I should have
 * found X by looking and did not" are different problems, and only one of them
 * is theirs to fix.
 */
export function describeMissingInputs(missing: readonly MissingInput[]): string {
  const fromUser = missing.filter((m) => m.source === "user");
  const discovered = missing.filter((m) => m.source === "discovered_on_surface");
  const other = missing.filter((m) => m.source !== "user" && m.source !== "discovered_on_surface");

  const parts: string[] = [];
  if (fromUser.length > 0) {
    parts.push(`I still need from you: ${fromUser.map((m) => m.label).join(", ")}.`);
  }
  if (discovered.length > 0) {
    parts.push(
      `I could not work out ${discovered
        .map((m) => m.label)
        .join(", ")} by looking at the page, so I have stopped rather than guess.`,
    );
  }
  if (other.length > 0) {
    parts.push(`Missing input: ${other.map((m) => m.label).join(", ")}.`);
  }
  return parts.join(" ");
}

/** Thrown when a run is started without the inputs its own spec requires. */
export class AgentInputError extends Error {
  readonly missing: readonly MissingInput[];

  constructor(readiness: Extract<InputReadiness, { ready: false }>) {
    super(describeMissingInputs(readiness.missing));
    this.name = "AgentInputError";
    this.missing = readiness.missing;
  }
}
