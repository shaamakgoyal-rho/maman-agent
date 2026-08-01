import { domainPackSchema, type DomainPack } from "./schema.js";

/**
 * Pack validation in two tiers.
 *
 * Tier 1 (errors) — shape, via the Zod schema. A pack that fails does not load.
 *
 * Tier 2 (integrity warnings) — cross-references the schema cannot express: a
 * signature that names an action or object the pack never declares can never
 * match, so the workflow is silently dead. These are WARNINGS, not errors,
 * deliberately: refusing to load an otherwise-good pack over one dead signature
 * would be worse, and inventing the missing declaration would mean putting
 * domain knowledge in code. They surface in `packs_status` instead.
 */

export type PackIssue = {
  /** Stable code so tests and UI can assert without string matching. */
  code:
    | "unknown_signature_action"
    | "unknown_signature_object"
    | "unknown_policy_action"
    | "unknown_trigger_object"
    | "action_object_mismatch"
    | "duplicate_id";
  /** Dotted path into the pack, e.g. workflows.invoice_intake.signature[3]. */
  path: string;
  message: string;
};

export type PackLoadResult =
  { ok: true; pack: DomainPack; warnings: PackIssue[] } | { ok: false; errors: string[] };

/** Splits a signature cell on "|" alternation; "*" stays as the wildcard. */
export function alternatives(cell: string): string[] {
  return cell
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

export function validatePack(raw: unknown): PackLoadResult {
  const parsed = domainPackSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    };
  }
  const pack = parsed.data;
  const warnings: PackIssue[] = [];

  const actionIds = new Set(pack.actions.map((a) => a.id));
  // Objects are addressable by id OR alias.
  const objectIds = new Set<string>();
  for (const o of pack.objects) {
    objectIds.add(o.id);
    for (const alias of o.aliases) objectIds.add(alias);
  }
  const actionById = new Map(pack.actions.map((a) => [a.id, a]));

  for (const dup of duplicates(pack.actions.map((a) => a.id))) {
    warnings.push({ code: "duplicate_id", path: `actions.${dup}`, message: `duplicate action id` });
  }
  for (const dup of duplicates(pack.objects.map((o) => o.id))) {
    warnings.push({ code: "duplicate_id", path: `objects.${dup}`, message: `duplicate object id` });
  }

  for (const wf of pack.workflows) {
    wf.signature.forEach((step, index) => {
      const [actionCell, objectCell] = step;
      const path = `workflows.${wf.id}.signature[${index}]`;

      for (const action of alternatives(actionCell)) {
        if (action === "*") continue;
        if (!actionIds.has(action)) {
          warnings.push({
            code: "unknown_signature_action",
            path,
            message: `action "${action}" is not declared in actions — this step can never match`,
          });
          continue;
        }
        // The action exists; check it is declared to apply to this object.
        const declared = actionById.get(action)!.on;
        if (declared.length === 0 || declared.includes("*")) continue;
        const objects = alternatives(objectCell).filter((o) => o !== "*");
        if (objects.length === 0) continue;
        const compatible = objects.some((o) => declared.includes(o));
        if (!compatible) {
          warnings.push({
            code: "action_object_mismatch",
            path,
            message: `action "${action}" declares on:[${declared.join(", ")}] but the step targets ${objects.join("|")}`,
          });
        }
      }

      for (const object of alternatives(objectCell)) {
        if (object === "*") continue;
        if (!objectIds.has(object)) {
          warnings.push({
            code: "unknown_signature_object",
            path,
            message: `object "${object}" is not declared in objects (or as an alias)`,
          });
        }
      }
    });
  }

  const policyActions = [
    ...pack.policy.segregation_of_duties.flatMap((r, i) =>
      r.cannot_combine.map((a) => ({ a, path: `policy.segregation_of_duties[${i}]` })),
    ),
    ...pack.policy.autonomy_rules.map((r, i) => ({
      a: r.match.action,
      path: `policy.autonomy_rules[${i}].match.action`,
    })),
    ...pack.policy.amount_extraction_required_for.map((a, i) => ({
      a,
      path: `policy.amount_extraction_required_for[${i}]`,
    })),
  ];
  for (const { a, path } of policyActions) {
    if (a !== "*" && !actionIds.has(a)) {
      warnings.push({
        code: "unknown_policy_action",
        path,
        message: `policy references action "${a}" which is not declared — the rule can never fire`,
      });
    }
  }

  pack.proactivity.event_triggers.forEach((t, i) => {
    if (!objectIds.has(t.watch)) {
      warnings.push({
        code: "unknown_trigger_object",
        path: `proactivity.event_triggers[${i}].watch`,
        message: `watches object "${t.watch}" which is not declared`,
      });
    }
  });

  return { ok: true, pack, warnings };
}
