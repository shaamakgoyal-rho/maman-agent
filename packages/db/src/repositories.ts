import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql, TransactionSql } from "postgres";
import type { OrganizationRole } from "@maman/contracts";
import * as schema from "./schema.js";
import { withTenant, type TenantContext } from "./tenant.js";
import { appendAuditEventTx } from "./audit.js";

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

/**
 * Tenant-scoped agent lookup. Returns null when the agent does not exist OR
 * belongs to another tenant — RLS makes those cases indistinguishable, so the
 * caller returns 404 (never 403), never leaking cross-tenant existence.
 */
export async function getAgentById(sql: Sql, ctx: TenantContext, agentId: string) {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.agents)
      .where(
        and(eq(schema.agents.organization_id, ctx.organizationId), eq(schema.agents.id, agentId)),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

// ---------- kill switch (org-wide agent halt) ----------

/**
 * Global kill switch: pauses EVERY non-retired agent in the org and marks
 * queued/running runs cancelled. Deterministic and idempotent; used by the
 * "stop everything" control. Returns what it affected.
 */
export async function engageKillSwitch(
  sql: Sql,
  ctx: TenantContext,
  actorUserId: string,
): Promise<{ paused_agents: number; halted_runs: number }> {
  return withTenant(sql, ctx, async (tx) => {
    const paused = await tx`
      UPDATE agents SET state = 'paused', updated_at = now()
      WHERE organization_id = ${ctx.organizationId}
        AND state IN ('observed', 'shadow', 'supervised', 'active')
      RETURNING id
    `;
    const halted = await tx`
      UPDATE agent_runs SET status = 'cancelled', completed_at = now()
      WHERE organization_id = ${ctx.organizationId}
        AND status IN ('queued', 'validating', 'running', 'waiting_approval')
      RETURNING id
    `;
    await appendAuditEventTx(tx, {
      organization_id: ctx.organizationId,
      actor_type: "user",
      actor_id: actorUserId,
      action: "kill_switch.engage",
      resource_type: "organization",
      resource_id: ctx.organizationId,
      outcome: "success",
      reason_code: "operator_initiated",
      metadata: { paused_agents: paused.length, halted_runs: halted.length },
    });
    return { paused_agents: paused.length, halted_runs: halted.length };
  });
}

// ---------- connector accounts (envelope-encrypted tokens) ----------

export type NewConnectorAccount = typeof schema.connector_accounts.$inferInsert;

/** Public connector view — NEVER includes ciphertext or data keys. */
export type ConnectorStatusView = {
  id: string;
  provider: string;
  display_label: string;
  scopes: string[];
  status: "connected" | "degraded" | "revoked";
  expires_at: string | null;
  last_verified_at: string | null;
};

function toStatusView(row: typeof schema.connector_accounts.$inferSelect): ConnectorStatusView {
  return {
    id: row.id,
    provider: row.provider,
    display_label: row.display_label,
    scopes: row.scopes,
    status: row.status,
    expires_at: row.expires_at,
    last_verified_at: row.last_verified_at,
  };
}

export async function upsertConnectorAccount(
  sql: Sql,
  ctx: TenantContext,
  account: NewConnectorAccount,
): Promise<ConnectorStatusView> {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await tx<Array<typeof schema.connector_accounts.$inferSelect>>`
      INSERT INTO connector_accounts (
        id, organization_id, owner_user_id, provider, external_account_id_hash,
        display_label, scopes, status, encrypted_token_ciphertext, encrypted_data_key,
        token_key_version, expires_at, last_verified_at, created_at, updated_at
      ) VALUES (
        ${account.id}, ${ctx.organizationId}, ${account.owner_user_id ?? null},
        ${account.provider}, ${account.external_account_id_hash}, ${account.display_label},
        ${account.scopes as string[]}, ${account.status},
        ${account.encrypted_token_ciphertext as Buffer}, ${account.encrypted_data_key as Buffer},
        ${account.token_key_version}, ${account.expires_at ?? null},
        ${account.last_verified_at ?? null}, now(), now()
      )
      ON CONFLICT (organization_id, provider, external_account_id_hash)
      DO UPDATE SET
        display_label = EXCLUDED.display_label,
        scopes = EXCLUDED.scopes,
        status = EXCLUDED.status,
        encrypted_token_ciphertext = EXCLUDED.encrypted_token_ciphertext,
        encrypted_data_key = EXCLUDED.encrypted_data_key,
        token_key_version = EXCLUDED.token_key_version,
        expires_at = EXCLUDED.expires_at,
        last_verified_at = EXCLUDED.last_verified_at,
        updated_at = now()
      RETURNING *
    `;
    return toStatusView(row!);
  });
}

export async function listConnectorAccounts(
  sql: Sql,
  ctx: TenantContext,
): Promise<ConnectorStatusView[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.connector_accounts)
      .where(eq(schema.connector_accounts.organization_id, ctx.organizationId));
    return rows.map(toStatusView);
  });
}

/** Loads the encrypted token material for server-side use ONLY (worker/API). */
export async function getConnectorSecret(
  sql: Sql,
  ctx: TenantContext,
  provider: string,
): Promise<{
  ciphertext: Buffer;
  encrypted_data_key: Buffer;
  key_version: number;
  status: string;
} | null> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx<
      Array<{
        encrypted_token_ciphertext: Buffer;
        encrypted_data_key: Buffer;
        token_key_version: number;
        status: string;
      }>
    >`
      SELECT encrypted_token_ciphertext, encrypted_data_key, token_key_version, status
      FROM connector_accounts
      WHERE organization_id = ${ctx.organizationId} AND provider = ${provider}
      ORDER BY updated_at DESC LIMIT 1
    `;
    if (rows.length === 0) return null;
    return {
      ciphertext: rows[0]!.encrypted_token_ciphertext,
      encrypted_data_key: rows[0]!.encrypted_data_key,
      key_version: rows[0]!.token_key_version,
      status: rows[0]!.status,
    };
  });
}

/** Persists a refreshed, re-encrypted token for an org+provider connector. */
export async function updateConnectorTokens(
  sql: Sql,
  ctx: TenantContext,
  input: {
    provider: string;
    ciphertext: Buffer;
    encrypted_data_key: Buffer;
    key_version: number;
    expires_at: string | null;
  },
): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    await tx`
      UPDATE connector_accounts
      SET encrypted_token_ciphertext = ${input.ciphertext},
          encrypted_data_key = ${input.encrypted_data_key},
          token_key_version = ${input.key_version},
          expires_at = ${input.expires_at},
          last_verified_at = now(),
          updated_at = now(),
          status = 'connected'
      WHERE organization_id = ${ctx.organizationId} AND provider = ${input.provider}
    `;
  });
}

/**
 * Disconnects a connector and PAUSES dependent agents in one transaction:
 * any active/supervised agent whose current version references a capability of
 * this provider is moved to 'paused'. Returns the paused agent count.
 */
export async function disconnectConnector(
  sql: Sql,
  ctx: TenantContext,
  provider: string,
): Promise<{ disconnected: boolean; paused_agents: number }> {
  return withTenant(sql, ctx, async (tx) => {
    const revoked = await tx`
      UPDATE connector_accounts SET status = 'revoked', updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND provider = ${provider}
      RETURNING id
    `;
    if (revoked.length === 0) return { disconnected: false, paused_agents: 0 };

    // Pause dependent agents: those whose spec JSON references the provider.
    const paused = await tx`
      UPDATE agents SET state = 'paused', updated_at = now()
      WHERE organization_id = ${ctx.organizationId}
        AND state IN ('active', 'supervised')
        AND id IN (
          SELECT av.agent_id FROM agent_versions av
          WHERE av.organization_id = ${ctx.organizationId}
            AND av.spec::text LIKE ${"%" + provider + ".%"}
        )
      RETURNING id
    `;
    return { disconnected: true, paused_agents: paused.length };
  });
}
