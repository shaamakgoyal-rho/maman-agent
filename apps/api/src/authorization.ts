import type { OrganizationRole, Principal } from "@maman/contracts";

/**
 * Centralized authorization. Every API handler calls `authorize` — ad hoc role
 * checks in route files are forbidden by convention and by review checklist.
 *
 * Actions are namespaced strings. The matrix is deliberately explicit and
 * deny-by-default: an action absent from the matrix is denied for everyone.
 */

export type AuthzAction =
  // personal resources (owner-scoped; ownership is enforced at the repository)
  | "patterns.read_own"
  | "patterns.write_own"
  | "recommendations.read_own"
  | "recommendations.write_own"
  | "agents.read_own"
  | "agents.write_own"
  | "runs.read_own"
  | "runs.write_own"
  | "runs.approve_own"
  | "devices.manage_own"
  | "connectors.manage_own"
  | "roi.read_own"
  // organization administration
  | "org.members.manage"
  | "org.policies.read"
  | "org.policies.write"
  | "org.budgets.read"
  | "org.budgets.write"
  | "org.connectors.read"
  | "org.audit.read"
  | "org.audit.export"
  | "org.overview.read"
  | "org.roi.read_aggregate"
  // security administration
  | "security.retention.write"
  | "security.deny_list.write"
  | "security.model_routing.write"
  // billing
  | "billing.usage.read";

const MEMBER_ACTIONS: AuthzAction[] = [
  "patterns.read_own",
  "patterns.write_own",
  "recommendations.read_own",
  "recommendations.write_own",
  "agents.read_own",
  "agents.write_own",
  "runs.read_own",
  "runs.write_own",
  "runs.approve_own",
  "devices.manage_own",
  "connectors.manage_own",
  "roi.read_own",
];

/**
 * Role → allowed actions.
 * NOTE deliberate absences (spec §3):
 * - No role has access to another member's raw events, screens, or event history —
 *   such actions do not exist in the action vocabulary at all.
 * - manager sees team aggregates only (cohort >= 5 enforced at the query layer).
 * - billing_admin cannot read workflow detail; security_admin cannot read raw events.
 */
const MATRIX: Record<OrganizationRole, ReadonlySet<AuthzAction>> = {
  member: new Set(MEMBER_ACTIONS),
  manager: new Set([...MEMBER_ACTIONS, "org.overview.read", "org.roi.read_aggregate"]),
  org_admin: new Set([
    ...MEMBER_ACTIONS,
    "org.members.manage",
    "org.policies.read",
    "org.policies.write",
    "org.budgets.read",
    "org.budgets.write",
    "org.connectors.read",
    "org.audit.read",
    "org.audit.export",
    "org.overview.read",
    "org.roi.read_aggregate",
  ]),
  security_admin: new Set([
    "org.policies.read",
    "org.policies.write",
    "org.connectors.read",
    "org.audit.read",
    "org.audit.export",
    "security.retention.write",
    "security.deny_list.write",
    "security.model_routing.write",
  ]),
  billing_admin: new Set(["billing.usage.read", "org.budgets.read", "org.overview.read"]),
};

export type AuthzDecision =
  { allowed: true } | { allowed: false; reason: "unknown_action" | "role_denied" };

export function authorize(principal: Principal, action: AuthzAction): AuthzDecision {
  const allowedActions = MATRIX[principal.role];
  if (!allowedActions) return { allowed: false, reason: "unknown_action" };
  if (!allowedActions.has(action)) return { allowed: false, reason: "role_denied" };
  return { allowed: true };
}
