import type { Sql } from "postgres";
import { aggregate, MIN_COHORT_SIZE } from "@maman/roi-engine";
import { withTenant } from "@maman/db";

/**
 * Admin aggregate reporting. Every figure is org-scoped and computed inside a
 * tenant transaction (RLS). Nothing here exposes per-user activity, screen
 * content, or a productivity ranking — those queries do not exist. Team
 * breakdowns below the cohort minimum are suppressed.
 */

export type AdminOverview = {
  organization_id: string;
  seats: { active_users: number; provisioned: number };
  devices: { healthy: number; degraded: number; offline: number };
  recommendations: { created: number; opened: number; accepted: number; dismissed: number };
  agents: Record<string, number>;
  runs: { completed: number; failed: number; total: number };
  value:
    | { suppressed: true; reason: string; cohort_size: number }
    | { suppressed: false; verified_hours: number; net_value_usd: number; cohort_size: number };
  cost: { model_usd: number; connector_usd: number };
  policy_blocks: number;
  connectors_needing_attention: number;
};

export async function adminOverview(sql: Sql, organizationId: string): Promise<AdminOverview> {
  return withTenant(sql, { organizationId }, async (tx) => {
    const num = (v: unknown) => Number(v ?? 0);

    const [seatRow] = await tx<{ active: string; total: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) AS total
      FROM memberships WHERE organization_id = ${organizationId}
    `;

    const [deviceRow] = await tx<{ healthy: string; offline: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at > now() - interval '10 minutes')) AS healthy,
        COUNT(*) FILTER (WHERE revoked_at IS NOT NULL OR last_seen_at <= now() - interval '10 minutes') AS offline
      FROM devices WHERE organization_id = ${organizationId}
    `;

    const [recRow] = await tx<
      { created: string; opened: string; accepted: string; dismissed: string }[]
    >`
      SELECT
        COUNT(*) AS created,
        COUNT(*) FILTER (WHERE status IN ('viewed','accepted','dismissed')) AS opened,
        COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
        COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed
      FROM recommendations WHERE organization_id = ${organizationId}
    `;

    const agentRows = await tx<{ state: string; n: string }[]>`
      SELECT state, COUNT(*) AS n FROM agents
      WHERE organization_id = ${organizationId} GROUP BY state
    `;
    const agents: Record<string, number> = {};
    for (const r of agentRows) agents[r.state] = num(r.n);

    const [runRow] = await tx<{ completed: string; failed: string; total: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('completed','completed_with_warnings')) AS completed,
        COUNT(*) FILTER (WHERE status IN ('failed','policy_blocked','budget_exceeded')) AS failed,
        COUNT(*) AS total
      FROM agent_runs WHERE organization_id = ${organizationId}
    `;

    // ROI: aggregate per-user, then suppress below the cohort minimum.
    const roiRows = await tx<{ owner_user_id: string; verified_ms: string; net_usd: string }[]>`
      SELECT owner_user_id,
             SUM(verified_saved_ms) AS verified_ms,
             SUM(COALESCE(net_value_usd, 0)) AS net_usd
      FROM roi_measurements
      WHERE organization_id = ${organizationId} AND verification_status = 'verified'
      GROUP BY owner_user_id
    `;
    const perUserHours = roiRows.map((r) => num(r.verified_ms) / 3_600_000);
    const perUserValue = roiRows.map((r) => num(r.net_usd));
    const agg = aggregate(
      { per_user_verified_hours: perUserHours, per_user_net_value_usd: perUserValue },
      MIN_COHORT_SIZE,
    );

    const [costRow] = await tx<{ model: string; connector: string }[]>`
      SELECT
        COALESCE(SUM(model_cost_usd), 0) AS model,
        COALESCE(SUM(connector_cost_usd), 0) AS connector
      FROM agent_runs WHERE organization_id = ${organizationId}
    `;

    const [blockRow] = await tx<{ n: string }[]>`
      SELECT COUNT(*) AS n FROM agent_runs
      WHERE organization_id = ${organizationId} AND status = 'policy_blocked'
    `;

    const [connRow] = await tx<{ n: string }[]>`
      SELECT COUNT(*) AS n FROM connector_accounts
      WHERE organization_id = ${organizationId} AND status IN ('degraded','revoked')
    `;

    return {
      organization_id: organizationId,
      seats: { active_users: num(seatRow?.active), provisioned: num(seatRow?.total) },
      devices: { healthy: num(deviceRow?.healthy), degraded: 0, offline: num(deviceRow?.offline) },
      recommendations: {
        created: num(recRow?.created),
        opened: num(recRow?.opened),
        accepted: num(recRow?.accepted),
        dismissed: num(recRow?.dismissed),
      },
      agents,
      runs: {
        completed: num(runRow?.completed),
        failed: num(runRow?.failed),
        total: num(runRow?.total),
      },
      value: agg.suppressed
        ? { suppressed: true, reason: agg.reason, cohort_size: agg.cohort_size }
        : {
            suppressed: false,
            verified_hours: agg.total_verified_hours,
            net_value_usd: agg.total_net_value_usd,
            cohort_size: agg.cohort_size,
          },
      cost: { model_usd: num(costRow?.model), connector_usd: num(costRow?.connector) },
      policy_blocks: num(blockRow?.n),
      connectors_needing_attention: num(connRow?.n),
    };
  });
}

export type AuditEntry = {
  occurred_at: string;
  actor_type: string;
  action: string;
  resource_type: string;
  outcome: string;
  reason_code: string | null;
};

export async function adminAudit(
  sql: Sql,
  organizationId: string,
  limit = 100,
): Promise<AuditEntry[]> {
  return withTenant(sql, { organizationId }, async (tx) => {
    const rows = await tx<AuditEntry[]>`
      SELECT occurred_at, actor_type, action, resource_type, outcome, reason_code
      FROM audit_events WHERE organization_id = ${organizationId}
      ORDER BY occurred_at DESC LIMIT ${limit}
    `;
    // Metadata only — never workflow content or personal raw events.
    return rows.map((r) => ({
      ...r,
      occurred_at: new Date(r.occurred_at).toISOString(),
    }));
  });
}
