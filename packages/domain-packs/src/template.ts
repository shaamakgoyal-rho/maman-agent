import { alternatives } from "./validate.js";
import type { DomainPack, PackCadence, PackWorkflow } from "./schema.js";

/**
 * Template matcher (L2) — recognizes a pack workflow inside one segmented
 * episode's domain-typed steps.
 *
 * Matching is an ORDERED subsequence alignment over the signature tuples
 * `[domain_action, domain_object, target_role]`:
 * - `*` in a cell matches anything, including an absent value;
 * - `a|b` matches either;
 * - object cells resolve pack aliases to canonical ids;
 * - unmatched events are noise and are skippable, but only up to
 *   `MAX_NOISE_BETWEEN_STEPS` between consecutive signature steps — a
 *   signature scattered across unrelated work is not a match;
 * - every signature step must match, in order.
 *
 * ACTION cells are satisfied two ways, because the L1 classifier can only
 * infer coarse actions (it deliberately picks the lowest-risk plausible one,
 * and can never produce a rich action like "three_way_match" from a generic
 * table_read):
 *   1. the classified action matches the cell exactly; or
 *   2. the cell's action is DECLARED by the pack for the step's matched
 *      object AND its risk is compatible with the observed event direction
 *      (read events satisfy none/low/medium actions; write events satisfy any
 *      non-none action). The step must still carry a classified object and an
 *      event type — an untyped event can never satisfy a concrete cell.
 * Disambiguation between workflows still comes from the full OBJECT sequence,
 * which the classifier does establish. Object and role cells always require an
 * exact (alias-resolved) match.
 */

/** How many non-matching events may sit between two matched signature steps. */
export const MAX_NOISE_BETWEEN_STEPS = 5;

/** The domain-typed view of one episode step, as the engine sees it. */
export type TemplateStepInput = {
  domain_action?: string;
  domain_object?: string;
  target_role?: string;
  /** Observed event type — enables plausible-action matching (see below). */
  event_type?: string;
};

export type TemplateMatch = {
  pack_domain: string;
  workflow_id: string;
  workflow_name: string;
  cadence: PackCadence;
  min_reps_with_template: number;
};

function cellMatches(
  cell: string,
  value: string | undefined,
  aliasMap?: Map<string, string>,
): boolean {
  for (const alternative of alternatives(cell)) {
    if (alternative === "*") return true;
    if (value === undefined) continue;
    const canonicalWanted = aliasMap?.get(alternative) ?? alternative;
    const canonicalValue = aliasMap?.get(value) ?? value;
    if (canonicalWanted === canonicalValue) return true;
  }
  return false;
}

function aliasMapFor(pack: DomainPack): Map<string, string> {
  const map = new Map<string, string>();
  for (const object of pack.objects) {
    map.set(object.id, object.id);
    for (const alias of object.aliases) map.set(alias, object.id);
  }
  return map;
}

const WRITE_EVENT_TYPES = new Set([
  "value_committed",
  "record_updated",
  "paste_semantic",
  "table_exported",
]);

/** Whether `actionId`, declared by the pack, is plausible for this step. */
function actionPlausible(
  pack: DomainPack,
  actionId: string,
  step: TemplateStepInput,
  aliasMap: Map<string, string>,
): boolean {
  if (step.domain_object === undefined || step.event_type === undefined) return false;
  const action = pack.actions.find((a) => a.id === actionId);
  if (!action) return false;
  const object = aliasMap.get(step.domain_object) ?? step.domain_object;
  const declaredForObject =
    action.on.length === 0 || action.on.includes("*") || action.on.includes(object);
  if (!declaredForObject) return false;
  const isWrite = WRITE_EVENT_TYPES.has(step.event_type);
  return isWrite ? action.risk !== "none" : action.risk !== "high" && action.risk !== "critical";
}

/** Matches one workflow signature against an episode's steps. */
export function matchSignature(
  pack: DomainPack,
  workflow: PackWorkflow,
  steps: TemplateStepInput[],
): boolean {
  const aliases = aliasMapFor(pack);
  let signatureIndex = 0;
  let noiseSinceLastMatch = 0;
  let anyMatched = false;

  for (const step of steps) {
    const [actionCell, objectCell, roleCell] = workflow.signature[signatureIndex]!;
    const actionOk =
      cellMatches(actionCell, step.domain_action) ||
      alternatives(actionCell).some((a) => a !== "*" && actionPlausible(pack, a, step, aliases));
    const matches =
      actionOk &&
      cellMatches(objectCell, step.domain_object, aliases) &&
      cellMatches(roleCell, step.target_role);

    if (matches) {
      signatureIndex += 1;
      noiseSinceLastMatch = 0;
      anyMatched = true;
      if (signatureIndex === workflow.signature.length) return true;
    } else if (anyMatched) {
      noiseSinceLastMatch += 1;
      if (noiseSinceLastMatch > MAX_NOISE_BETWEEN_STEPS) return false;
    }
    // Leading noise before the first matched step is unlimited: an episode may
    // begin with unrelated context before the workflow starts.
  }
  return false;
}

/**
 * Matches an episode against every workflow in every pack, first match wins
 * with deterministic ordering (packs by domain id, workflows in pack order —
 * pack authors put more specific workflows first).
 */
export function matchEpisode(
  packs: DomainPack[],
  steps: TemplateStepInput[],
): TemplateMatch | null {
  // An episode with no domain typing at all can never match: signatures name
  // pack ids that only classified events carry.
  if (!steps.some((s) => s.domain_action !== undefined || s.domain_object !== undefined)) {
    return null;
  }
  for (const pack of [...packs].sort((a, b) => a.domain.localeCompare(b.domain))) {
    for (const workflow of pack.workflows) {
      if (matchSignature(pack, workflow, steps)) {
        return {
          pack_domain: pack.domain,
          workflow_id: workflow.id,
          workflow_name: workflow.name,
          cadence: workflow.cadence,
          min_reps_with_template: workflow.min_reps_with_template,
        };
      }
    }
  }
  return null;
}

/**
 * Counts repetitions the way the workflow's cadence intends:
 * - `fiscal_monthly`: distinct calendar months (two month-ends = 2 reps);
 * - `weekly`: distinct ISO weeks;
 * - everything else: one rep per episode.
 *
 * Deterministic on ISO-8601 UTC timestamps.
 */
export function templateReps(startedAt: string[], cadence: PackCadence): number {
  if (cadence === "fiscal_monthly") {
    return new Set(startedAt.map((t) => t.slice(0, 7))).size; // YYYY-MM
  }
  if (cadence === "weekly") {
    return new Set(startedAt.map((t) => isoWeek(t))).size;
  }
  return startedAt.length;
}

/** ISO-8601 week id, e.g. "2026-W31". */
function isoWeek(timestamp: string): string {
  const date = new Date(timestamp);
  // Shift to the Thursday of this week (ISO weeks belong to the year of their Thursday).
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - day + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
