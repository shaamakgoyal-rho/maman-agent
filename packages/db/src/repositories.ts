import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql, TransactionSql } from "postgres";
import type { OrganizationRole } from "@maman/contracts";
import * as schema from "./schema.js";
import { withTenant, type TenantContext } from "./tenant.js";

/**
 * Tenant-scoped repositories. Every function REQUIRES TenantContext and runs
 * inside a SET LOCAL app.organization_id transaction, so PostgreSQL RLS backs
 * every application-level filter. Global (non-tenant) tables expose explicit
 * `global*` functions that never touch tenant rows.
 */

const db = (tx: TransactionSql) => drizzle(tx as unknown as Sql, { schema });

// ---------- global identity (no tenant rows) ----------

export type NewOrganization = typeof schema.organizations.$inferInsert;
export type NewUser = typeof schema.users.$inferInsert;

export async function globalCreateOrganization(sql: Sql, org: NewOrganization) {
  const [row] = await drizzle(sql).insert(schema.organizations).values(org).returning();
  return row!;
}

export async function globalCreateUser(sql: Sql, user: NewUser) {
  const [row] = await drizzle(sql).insert(schema.users).values(user).returning();
  return row!;
}

export async function globalGetUserByWorkosId(sql: Sql, workosUserId: string) {
  const rows = await drizzle(sql)
    .select()
    .from(schema.users)
    .where(eq(schema.users.workos_user_id, workosUserId));
  return rows[0] ?? null;
}

// ---------- memberships ----------

export async function addMembership(
  sql: Sql,
  ctx: TenantContext,
  input: { user_id: string; role: OrganizationRole },
) {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .insert(schema.memberships)
      .values({
        organization_id: ctx.organizationId,
        user_id: input.user_id,
        role: input.role,
        status: "active",
      })
      .returning();
    return row!;
  });
}

export async function getMembership(sql: Sql, ctx: TenantContext, userId: string) {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.organization_id, ctx.organizationId),
          eq(schema.memberships.user_id, userId),
        ),
      );
    return rows[0] ?? null;
  });
}

export async function listMemberships(sql: Sql, ctx: TenantContext) {
  return withTenant(sql, ctx, (tx) =>
    db(tx)
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.organization_id, ctx.organizationId)),
  );
}

// ---------- devices ----------

export type NewDevice = typeof schema.devices.$inferInsert;

export async function registerDevice(sql: Sql, ctx: TenantContext, device: NewDevice) {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await db(tx).insert(schema.devices).values(device).returning();
    return row!;
  });
}

export async function getDevice(sql: Sql, ctx: TenantContext, deviceId: string) {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.devices)
      .where(
        and(
          eq(schema.devices.organization_id, ctx.organizationId),
          eq(schema.devices.id, deviceId),
        ),
      );
    return rows[0] ?? null;
  });
}

export async function listDevicesForUser(sql: Sql, ctx: TenantContext, userId: string) {
  return withTenant(sql, ctx, (tx) =>
    db(tx)
      .select()
      .from(schema.devices)
      .where(
        and(
          eq(schema.devices.organization_id, ctx.organizationId),
          eq(schema.devices.owner_user_id, userId),
        ),
      ),
  );
}

export async function revokeDevice(sql: Sql, ctx: TenantContext, deviceId: string) {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .update(schema.devices)
      .set({ revoked_at: new Date().toISOString() })
      .where(
        and(
          eq(schema.devices.organization_id, ctx.organizationId),
          eq(schema.devices.id, deviceId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

// ---------- patterns ----------

export type NewPattern = typeof schema.patterns.$inferInsert;

export async function createPattern(sql: Sql, ctx: TenantContext, pattern: NewPattern) {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await db(tx).insert(schema.patterns).values(pattern).returning();
    return row!;
  });
}

export async function getPatternOwned(sql: Sql, ctx: TenantContext, patternId: string) {
  return withTenant(sql, ctx, async (tx) => {
    if (!ctx.userId) return null;
    const rows = await db(tx)
      .select()
      .from(schema.patterns)
      .where(
        and(
          eq(schema.patterns.organization_id, ctx.organizationId),
          eq(schema.patterns.owner_user_id, ctx.userId),
          eq(schema.patterns.id, patternId),
        ),
      );
    return rows[0] ?? null;
  });
}

export async function deletePatternOwned(sql: Sql, ctx: TenantContext, patternId: string) {
  return withTenant(sql, ctx, async (tx) => {
    if (!ctx.userId) return false;
    const rows = await db(tx)
      .delete(schema.patterns)
      .where(
        and(
          eq(schema.patterns.organization_id, ctx.organizationId),
          eq(schema.patterns.owner_user_id, ctx.userId),
          eq(schema.patterns.id, patternId),
        ),
      )
      .returning({ id: schema.patterns.id });
    return rows.length > 0;
  });
}

// ---------- recommendations ----------

export type NewRecommendation = typeof schema.recommendations.$inferInsert;

export async function createRecommendation(sql: Sql, ctx: TenantContext, rec: NewRecommendation) {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await db(tx).insert(schema.recommendations).values(rec).returning();
    return row!;
  });
}

export async function getRecommendationOwned(
  sql: Sql,
  ctx: TenantContext,
  recommendationId: string,
) {
  return withTenant(sql, ctx, async (tx) => {
    if (!ctx.userId) return null;
    const rows = await db(tx)
      .select()
      .from(schema.recommendations)
      .where(
        and(
          eq(schema.recommendations.organization_id, ctx.organizationId),
          eq(schema.recommendations.owner_user_id, ctx.userId),
          eq(schema.recommendations.id, recommendationId),
        ),
      );
    return rows[0] ?? null;
  });
}

export async function listRecommendationsOwned(sql: Sql, ctx: TenantContext) {
  return withTenant(sql, ctx, async (tx) => {
    if (!ctx.userId) return [];
    return db(tx)
      .select()
      .from(schema.recommendations)
      .where(
        and(
          eq(schema.recommendations.organization_id, ctx.organizationId),
          eq(schema.recommendations.owner_user_id, ctx.userId),
        ),
      )
      .orderBy(desc(schema.recommendations.created_at));
  });
}

export async function updateRecommendationStatusOwned(
  sql: Sql,
  ctx: TenantContext,
  recommendationId: string,
  update: {
    status: (typeof schema.recommendations.$inferSelect)["status"];
    dismissal_reason?: string;
    snoozed_until?: string;
    surfaced_at?: string;
  },
) {
  return withTenant(sql, ctx, async (tx) => {
    if (!ctx.userId) return null;
    const [row] = await db(tx)
      .update(schema.recommendations)
      .set({ ...update, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(schema.recommendations.organization_id, ctx.organizationId),
          eq(schema.recommendations.owner_user_id, ctx.userId),
          eq(schema.recommendations.id, recommendationId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

// ---------- agents and immutable versions ----------

export type NewAgent = typeof schema.agents.$inferInsert;
export type NewAgentVersion = typeof schema.agent_versions.$inferInsert;

export async function createAgentWithVersion(
  sql: Sql,
  ctx: TenantContext,
  agent: NewAgent,
  version: NewAgentVersion,
) {
  return withTenant(sql, ctx, async (tx) => {
    const [agentRow] = await db(tx).insert(schema.agents).values(agent).returning();
    const [versionRow] = await db(tx).insert(schema.agent_versions).values(version).returning();
    const [updated] = await db(tx)
      .update(schema.agents)
      .set({ current_version_id: versionRow!.id, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(schema.agents.organization_id, ctx.organizationId),
          eq(schema.agents.id, agentRow!.id),
        ),
      )
      .returning();
    return { agent: updated!, version: versionRow! };
  });
}

export async function getAgentOwned(sql: Sql, ctx: TenantContext, agentId: string) {
  return withTenant(sql, ctx, async (tx) => {
    if (!ctx.userId) return null;
    const rows = await db(tx)
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.organization_id, ctx.organizationId),
          eq(schema.agents.owner_user_id, ctx.userId),
          eq(schema.agents.id, agentId),
        ),
      );
    return rows[0] ?? null;
  });
}

// ---------- policies ----------

export type NewPolicyVersion = typeof schema.policy_versions.$inferInsert;

export async function createPolicyVersion(sql: Sql, ctx: TenantContext, policy: NewPolicyVersion) {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await db(tx).insert(schema.policy_versions).values(policy).returning();
    return row!;
  });
}

export async function getLatestPolicyVersion(sql: Sql, ctx: TenantContext) {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.policy_versions)
      .where(eq(schema.policy_versions.organization_id, ctx.organizationId))
      .orderBy(desc(schema.policy_versions.version_number))
      .limit(1);
    return rows[0] ?? null;
  });
}
