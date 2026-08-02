import {
  exceedsThreshold,
  lowerCeiling,
  type AutonomyLevel,
  type DomainPack,
  type Extraction,
} from "@maman/domain-packs";

/**
 * Domain-pack policy (L3) evaluated in the approval chain.
 *
 * THREE INVARIANTS, all structural rather than conventional:
 *
 * 1. POLICY CAN ONLY RESTRICT. There is no code path here that grants
 *    autonomy, clears an approval, or raises a ceiling. `applyPackPolicy`
 *    takes the ceiling the run would otherwise have and returns one that is
 *    equal or stricter (`lowerCeiling`), and `requires_human` / `always_gate`
 *    are one-way latches.
 * 2. IT RUNS BEFORE THE AUTONOMY CHECK. Callers evaluate this first and treat
 *    its ceiling as the upper bound on anything earned history could unlock.
 * 3. VALUE MATCHERS FAIL CLOSED. `amount_usd_gt` / `discount_pct_gt` compare
 *    through `exceedsThreshold`, so an unreadable or low-confidence extraction
 *    counts as OVER the threshold — a failed read gates harder, never softer.
 *
 * Pure and deterministic: packs arrive as data (this package may not read the
 * filesystem or call a model), and identical input yields an identical verdict.
 */

/** One step, in the terms pack policy reasons about. */
export type PackPolicyStep = {
  /** Stable step id, for binding decisions to steps. */
  step_id: string;
  /** Pack action this step performs, if the step maps to one. */
  domain_action?: string;
  /** Business object instance the step touches (for per-instance SoD). */
  object_instance?: string;
  /** Records this step would write, for `record_count_gt`. */
  record_count?: number;
  /** Extracted monetary value, for `amount_usd_gt`. */
  amount_usd?: Extraction;
  /** Extracted percentage, for `discount_pct_gt`. */
  discount_pct?: Extraction;
};

export type PackPolicyVerdict = {
  /** The strictest ceiling any matching rule imposes; undefined = unconstrained. */
  ceiling?: AutonomyLevel;
  /** True when a human must approve this step every run, regardless of history. */
  always_gate: boolean;
  /**
   * True when the step needs a SECOND approver. In single-user mode the run
   * must hold rather than proceed — one person cannot satisfy dual control.
   */
  dual_control: boolean;
  /**
   * True when policy forbids THIS agent from performing the step at all, so it
   * becomes a mandatory human step (segregation of duties).
   */
  requires_human: boolean;
  /** Machine-readable, UI-renderable explanations. Never empty when restricted. */
  reasons: PackPolicyReason[];
};

export type PackPolicyReason = {
  code: "sod_conflict" | "autonomy_capped" | "always_gate" | "dual_control" | "value_unreadable";
  /** Worker-facing sentence — the cap is a feature, so it is stated plainly. */
  message: string;
  rule_id: string;
  pack_domain: string;
};

const UNRESTRICTED: PackPolicyVerdict = {
  always_gate: false,
  dual_control: false,
  requires_human: false,
  reasons: [],
};

/** Human-readable action name for policy copy ("code_invoice" → "code invoice"). */
function humanize(action: string): string {
  return action.replace(/_/g, " ");
}

/**
 * Segregation of duties: an agent may not perform two conflicting actions on
 * the SAME object instance — across steps in one run and across runs for the
 * same instance. `priorActions` carries what this agent already did to this
 * instance (from receipts), so the check spans runs rather than just the run
 * in front of us.
 */
function sodConflict(
  pack: DomainPack,
  step: PackPolicyStep,
  siblingActions: string[],
  priorActions: string[],
): PackPolicyReason | null {
  const action = step.domain_action;
  if (!action) return null;
  const alreadyDone = new Set([...siblingActions, ...priorActions]);

  for (const [index, rule] of pack.policy.segregation_of_duties.entries()) {
    if (!rule.cannot_combine.includes(action)) continue;
    const conflicting = rule.cannot_combine.find((a) => a !== action && alreadyDone.has(a));
    if (!conflicting) continue;
    return {
      code: "sod_conflict",
      message:
        `Policy: a person approves what Maman ${humanize(conflicting)}d — ` +
        `one agent may not both ${humanize(conflicting)} and ${humanize(action)}` +
        `${step.object_instance ? " on the same record" : ""}.`,
      rule_id: `PACK-SOD-${index + 1}`,
      pack_domain: pack.domain,
    };
  }
  return null;
}

/** Whether an autonomy rule's value matchers are satisfied (fail-closed). */
function matcherHits(
  match: DomainPack["policy"]["autonomy_rules"][number]["match"],
  step: PackPolicyStep,
  pack: DomainPack,
  ruleId: string,
): { hit: boolean; reason?: PackPolicyReason } {
  if (match.action !== step.domain_action) return { hit: false };

  if (match.amount_usd_gt !== undefined) {
    const verdict = exceedsThreshold(
      step.amount_usd ?? { value: null, confidence: 0 },
      match.amount_usd_gt,
    );
    if (!verdict.exceeded) return { hit: false };
    if (verdict.reason !== "over_threshold") {
      return {
        hit: true,
        reason: {
          code: "value_unreadable",
          message:
            `Gated because Maman could not read the amount confidently — ` +
            `an unreadable value is treated as over the $${match.amount_usd_gt} limit.`,
          rule_id: ruleId,
          pack_domain: pack.domain,
        },
      };
    }
    return { hit: true };
  }

  if (match.discount_pct_gt !== undefined) {
    const verdict = exceedsThreshold(
      step.discount_pct ?? { value: null, confidence: 0 },
      match.discount_pct_gt,
    );
    if (!verdict.exceeded) return { hit: false };
    if (verdict.reason !== "over_threshold") {
      return {
        hit: true,
        reason: {
          code: "value_unreadable",
          message:
            `Gated because Maman could not read the discount confidently — ` +
            `an unreadable value is treated as over ${match.discount_pct_gt}%.`,
          rule_id: ruleId,
          pack_domain: pack.domain,
        },
      };
    }
    return { hit: true };
  }

  if (match.record_count_gt !== undefined) {
    // A missing count is also fail-closed: unknown breadth is treated as large.
    const count = step.record_count;
    return { hit: count === undefined || count > match.record_count_gt };
  }

  return { hit: true }; // action-only matcher
}

const LEVEL_COPY: Record<AutonomyLevel, string> = {
  draft_only: "Draft-only",
  stage_only: "Stage-only",
  dry_run_first: "Dry-run first",
  never_autonomous: "Never autonomous",
};

/**
 * Evaluates every pack against one step. Verdicts combine by taking the
 * STRICTEST outcome across all packs and rules — there is deliberately no
 * "most permissive wins" path.
 */
export function evaluatePackPolicy(
  packs: DomainPack[],
  step: PackPolicyStep,
  options: {
    /** Other steps in this run that already ran against the same instance. */
    sibling_actions?: string[];
    /** Actions this agent performed on this instance in earlier runs. */
    prior_actions?: string[];
  } = {},
): PackPolicyVerdict {
  if (!step.domain_action) return UNRESTRICTED;

  let ceiling: AutonomyLevel | undefined;
  let alwaysGate = false;
  let dualControl = false;
  let requiresHuman = false;
  const reasons: PackPolicyReason[] = [];

  for (const pack of [...packs].sort((a, b) => a.domain.localeCompare(b.domain))) {
    const sod = sodConflict(pack, step, options.sibling_actions ?? [], options.prior_actions ?? []);
    if (sod) {
      requiresHuman = true;
      alwaysGate = true;
      reasons.push(sod);
    }

    for (const [index, rule] of pack.policy.autonomy_rules.entries()) {
      const ruleId = `PACK-AUTO-${index + 1}`;
      const { hit, reason: valueReason } = matcherHits(rule.match, step, pack, ruleId);
      if (!hit) continue;
      if (valueReason) reasons.push(valueReason);

      if (rule.rule.max_level) {
        ceiling = ceiling ? lowerCeiling(ceiling, rule.rule.max_level) : rule.rule.max_level;
        reasons.push({
          code: "autonomy_capped",
          message: `${LEVEL_COPY[rule.rule.max_level]}: ${pack.domain} policy for ${humanize(rule.match.action)}.`,
          rule_id: ruleId,
          pack_domain: pack.domain,
        });
      }
      if (rule.rule.always_gate) {
        alwaysGate = true;
        reasons.push({
          code: "always_gate",
          message: `Always needs your approval: ${pack.domain} policy for ${humanize(rule.match.action)}.`,
          rule_id: ruleId,
          pack_domain: pack.domain,
        });
      }
      if (rule.rule.dual_control) {
        dualControl = true;
        alwaysGate = true;
        reasons.push({
          code: "dual_control",
          message: `Requires a second approver in team mode: ${pack.domain} policy for ${humanize(rule.match.action)}.`,
          rule_id: ruleId,
          pack_domain: pack.domain,
        });
      }
    }
  }

  return {
    ...(ceiling ? { ceiling } : {}),
    always_gate: alwaysGate,
    dual_control: dualControl,
    requires_human: requiresHuman,
    reasons,
  };
}

/**
 * Applies a verdict to the ceiling a run would otherwise have. Returns a level
 * that is equal or stricter — never more permissive. This is the single place
 * callers should combine pack policy with earned autonomy.
 */
export function applyPackPolicy(
  current: AutonomyLevel | undefined,
  verdict: PackPolicyVerdict,
): AutonomyLevel | undefined {
  if (!verdict.ceiling) return current;
  if (!current) return verdict.ceiling;
  return lowerCeiling(current, verdict.ceiling);
}

/** True when the step may not run unattended under this verdict. */
export function needsHumanApproval(verdict: PackPolicyVerdict): boolean {
  return verdict.always_gate || verdict.requires_human || verdict.dual_control;
}
