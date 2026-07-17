/**
 * Drizzle table definitions. The hand-authored SQL in migrations/ is the DDL
 * ground truth (it carries RLS, triggers, and partial indexes that drizzle-kit
 * cannot fully express, and every migration has a tested down file). This
 * schema mirrors it exactly for typed repository queries; drift is caught by
 * the integration suite which introspects the live schema.
 */
import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

const utc = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  workos_organization_id: text("workos_organization_id").notNull().unique(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull(),
  default_timezone: text("default_timezone").notNull(),
  loaded_hourly_rate_usd: numeric("loaded_hourly_rate_usd", { precision: 14, scale: 6 }),
  created_at: utc("created_at").notNull().defaultNow(),
  updated_at: utc("updated_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  workos_user_id: text("workos_user_id").notNull().unique(),
  email: text("email").notNull(),
  display_name: text("display_name").notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
  updated_at: utc("updated_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    organization_id: uuid("organization_id").notNull(),
    user_id: uuid("user_id").notNull(),
    role: text("role", {
      enum: ["member", "manager", "org_admin", "security_admin", "billing_admin"],
    }).notNull(),
    status: text("status", { enum: ["active", "suspended", "removed"] }).notNull(),
    created_at: utc("created_at").notNull().defaultNow(),
    updated_at: utc("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organization_id, t.user_id] })],
);

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  device_public_id: uuid("device_public_id").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version").notNull(),
  observer_version: text("observer_version").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  last_seen_at: utc("last_seen_at"),
  revoked_at: utc("revoked_at"),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const desktop_auth_transactions = pgTable("desktop_auth_transactions", {
  id: uuid("id").primaryKey(),
  device_public_id: uuid("device_public_id").notNull(),
  state_sha256: text("state_sha256").notNull().unique(),
  pkce_challenge: text("pkce_challenge").notNull(),
  redirect_uri: text("redirect_uri").notNull(),
  organization_id: uuid("organization_id"),
  user_id: uuid("user_id"),
  authorization_code_sha256: text("authorization_code_sha256").unique(),
  status: text("status", {
    enum: ["pending", "authenticated", "exchanged", "expired"],
  }).notNull(),
  expires_at: utc("expires_at").notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const device_sessions = pgTable("device_sessions", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  user_id: uuid("user_id").notNull(),
  device_id: uuid("device_id").notNull(),
  token_family_id: uuid("token_family_id").notNull(),
  refresh_token_sha256: text("refresh_token_sha256").notNull().unique(),
  rotated_from_session_id: uuid("rotated_from_session_id"),
  expires_at: utc("expires_at").notNull(),
  revoked_at: utc("revoked_at"),
  last_used_at: utc("last_used_at"),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const patterns = pgTable("patterns", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  local_pattern_id: uuid("local_pattern_id").notNull(),
  generalized_intent: text("generalized_intent").notNull(),
  app_categories: text("app_categories").array().notNull(),
  occurrence_count: integer("occurrence_count").notNull(),
  distinct_day_count: integer("distinct_day_count").notNull(),
  median_duration_ms: integer("median_duration_ms").notNull(),
  similarity_mean: numeric("similarity_mean", { precision: 6, scale: 5 }).notNull(),
  projected_minutes_saved_weekly: numeric("projected_minutes_saved_weekly", {
    precision: 10,
    scale: 2,
  }).notNull(),
  opportunity_score: numeric("opportunity_score", { precision: 6, scale: 5 }).notNull(),
  risk_score: numeric("risk_score", { precision: 6, scale: 5 }).notNull(),
  share_status: text("share_status", { enum: ["private", "org_pattern"] }).notNull(),
  status: text("status", {
    enum: ["candidate", "eligible", "suggested", "dismissed", "converted"],
  }).notNull(),
  summary_payload: jsonb("summary_payload").notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
  updated_at: utc("updated_at").notNull().defaultNow(),
});

export const recommendations = pgTable("recommendations", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  pattern_id: uuid("pattern_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  evidence_payload: jsonb("evidence_payload").notNull(),
  confidence: numeric("confidence", { precision: 6, scale: 5 }).notNull(),
  risk_level: text("risk_level", { enum: ["low", "medium", "high"] }).notNull(),
  projected_minutes_saved_weekly: numeric("projected_minutes_saved_weekly", {
    precision: 10,
    scale: 2,
  }).notNull(),
  expected_cost_low: numeric("expected_cost_low", { precision: 14, scale: 6 }).notNull(),
  expected_cost_high: numeric("expected_cost_high", { precision: 14, scale: 6 }).notNull(),
  required_capabilities: text("required_capabilities").array().notNull(),
  status: text("status", {
    enum: ["new", "viewed", "snoozed", "dismissed", "blocked", "accepted"],
  }).notNull(),
  dismissal_reason: text("dismissal_reason"),
  surfaced_at: utc("surfaced_at"),
  snoozed_until: utc("snoozed_until"),
  created_at: utc("created_at").notNull().defaultNow(),
  updated_at: utc("updated_at").notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  source_pattern_id: uuid("source_pattern_id"),
  source_recommendation_id: uuid("source_recommendation_id"),
  name: text("name").notNull(),
  description: text("description").notNull(),
  state: text("state", {
    enum: ["draft", "shadow", "supervised", "active", "paused", "degraded", "revoked", "archived"],
  }).notNull(),
  current_version_id: uuid("current_version_id"),
  created_at: utc("created_at").notNull().defaultNow(),
  updated_at: utc("updated_at").notNull().defaultNow(),
  archived_at: utc("archived_at"),
});

export const agent_versions = pgTable("agent_versions", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  agent_id: uuid("agent_id").notNull(),
  version_number: integer("version_number").notNull(),
  schema_version: integer("schema_version").notNull(),
  spec: jsonb("spec").notNull(),
  spec_sha256: text("spec_sha256").notNull(),
  created_by_user_id: uuid("created_by_user_id"),
  created_by_type: text("created_by_type", { enum: ["user", "compiler", "migration"] }).notNull(),
  policy_version_id: uuid("policy_version_id").notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const agent_runs = pgTable("agent_runs", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  agent_id: uuid("agent_id").notNull(),
  agent_version_id: uuid("agent_version_id").notNull(),
  temporal_workflow_id: text("temporal_workflow_id").notNull().unique(),
  trigger_type: text("trigger_type", { enum: ["manual", "schedule", "event"] }).notNull(),
  trigger_idempotency_key: text("trigger_idempotency_key").notNull(),
  mode: text("mode", { enum: ["shadow", "supervised", "active"] }).notNull(),
  status: text("status").notNull(),
  policy_version_id: uuid("policy_version_id").notNull(),
  requested_at: utc("requested_at").notNull(),
  started_at: utc("started_at"),
  completed_at: utc("completed_at"),
  model_input_tokens: bigint("model_input_tokens", { mode: "number" }).notNull().default(0),
  model_output_tokens: bigint("model_output_tokens", { mode: "number" }).notNull().default(0),
  model_cost_usd: numeric("model_cost_usd", { precision: 14, scale: 6 }).notNull().default("0"),
  connector_cost_usd: numeric("connector_cost_usd", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  intervention_ms: bigint("intervention_ms", { mode: "number" }).notNull().default(0),
  error_code: text("error_code"),
  error_summary: text("error_summary"),
});

export const run_steps = pgTable("run_steps", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  run_id: uuid("run_id").notNull(),
  step_id: text("step_id").notNull(),
  step_order: integer("step_order").notNull(),
  capability_id: text("capability_id").notNull(),
  capability_version: integer("capability_version").notNull(),
  mode: text("mode", { enum: ["read", "propose_write", "write"] }).notNull(),
  risk_level: text("risk_level", { enum: ["low", "medium", "high", "prohibited"] }).notNull(),
  status: text("status", {
    enum: ["pending", "running", "waiting_approval", "completed", "failed", "skipped"],
  }).notNull(),
  input_digest: text("input_digest").notNull(),
  output_payload: jsonb("output_payload"),
  diff_payload: jsonb("diff_payload"),
  diff_sha256: text("diff_sha256"),
  idempotency_key: text("idempotency_key"),
  attempt_count: integer("attempt_count").notNull().default(0),
  started_at: utc("started_at"),
  completed_at: utc("completed_at"),
  error_code: text("error_code"),
  error_summary: text("error_summary"),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  run_id: uuid("run_id").notNull(),
  run_step_id: uuid("run_step_id").notNull(),
  requested_from_user_id: uuid("requested_from_user_id").notNull(),
  diff_sha256: text("diff_sha256").notNull(),
  token_sha256: text("token_sha256").notNull().unique(),
  status: text("status", {
    enum: ["pending", "approved", "rejected", "expired", "invalidated"],
  }).notNull(),
  requested_at: utc("requested_at").notNull(),
  expires_at: utc("expires_at").notNull(),
  decided_at: utc("decided_at"),
  decided_by_user_id: uuid("decided_by_user_id"),
  reason: text("reason"),
});

export const policy_versions = pgTable("policy_versions", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  version_number: integer("version_number").notNull(),
  policy: jsonb("policy").notNull(),
  sha256: text("sha256").notNull(),
  created_by_user_id: uuid("created_by_user_id").notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const usage_reservations = pgTable("usage_reservations", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  run_id: uuid("run_id").notNull().unique(),
  reserved_cost_usd: numeric("reserved_cost_usd", { precision: 14, scale: 6 }).notNull(),
  reserved_record_reads: integer("reserved_record_reads").notNull(),
  reserved_record_writes: integer("reserved_record_writes").notNull(),
  consumed_cost_usd: numeric("consumed_cost_usd", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  status: text("status", { enum: ["active", "released", "consumed", "expired"] }).notNull(),
  expires_at: utc("expires_at").notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
  updated_at: utc("updated_at").notNull().defaultNow(),
});

export const provider_price_versions = pgTable("provider_price_versions", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  model_or_service: text("model_or_service").notNull(),
  effective_from: utc("effective_from").notNull(),
  effective_to: utc("effective_to"),
  unit: text("unit").notNull(),
  input_price_usd: numeric("input_price_usd", { precision: 18, scale: 9 }),
  output_price_usd: numeric("output_price_usd", { precision: 18, scale: 9 }),
  flat_price_usd: numeric("flat_price_usd", { precision: 18, scale: 9 }),
  source_url: text("source_url"),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const connector_accounts = pgTable("connector_accounts", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id"),
  provider: text("provider").notNull(),
  external_account_id_hash: text("external_account_id_hash").notNull(),
  display_label: text("display_label").notNull(),
  scopes: text("scopes").array().notNull(),
  status: text("status", { enum: ["connected", "degraded", "revoked"] }).notNull(),
  encrypted_token_ciphertext: bytea("encrypted_token_ciphertext").notNull(),
  encrypted_data_key: bytea("encrypted_data_key").notNull(),
  token_key_version: integer("token_key_version").notNull(),
  expires_at: utc("expires_at"),
  last_verified_at: utc("last_verified_at"),
  created_at: utc("created_at").notNull().defaultNow(),
  updated_at: utc("updated_at").notNull().defaultNow(),
});

export const roi_baselines = pgTable("roi_baselines", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  pattern_id: uuid("pattern_id").notNull(),
  median_manual_duration_ms: bigint("median_manual_duration_ms", { mode: "number" }).notNull(),
  occurrence_count: integer("occurrence_count").notNull(),
  confidence: numeric("confidence", { precision: 6, scale: 5 }).notNull(),
  user_confirmed: boolean("user_confirmed").notNull().default(false),
  measured_from: utc("measured_from").notNull(),
  measured_to: utc("measured_to").notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const roi_measurements = pgTable("roi_measurements", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  owner_user_id: uuid("owner_user_id").notNull(),
  agent_id: uuid("agent_id").notNull(),
  run_id: uuid("run_id").notNull().unique(),
  baseline_ms: bigint("baseline_ms", { mode: "number" }).notNull(),
  automated_human_ms: bigint("automated_human_ms", { mode: "number" }).notNull(),
  intervention_ms: bigint("intervention_ms", { mode: "number" }).notNull(),
  verified_saved_ms: bigint("verified_saved_ms", { mode: "number" }).notNull(),
  gross_value_usd: numeric("gross_value_usd", { precision: 14, scale: 6 }),
  model_cost_usd: numeric("model_cost_usd", { precision: 14, scale: 6 }).notNull(),
  connector_cost_usd: numeric("connector_cost_usd", { precision: 14, scale: 6 }).notNull(),
  infrastructure_cost_usd: numeric("infrastructure_cost_usd", {
    precision: 14,
    scale: 6,
  }).notNull(),
  net_value_usd: numeric("net_value_usd", { precision: 14, scale: 6 }),
  verification_status: text("verification_status", {
    enum: ["projected", "verified", "disputed"],
  }).notNull(),
  created_at: utc("created_at").notNull().defaultNow(),
});

export const audit_events = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id").notNull(),
  actor_type: text("actor_type", { enum: ["user", "device", "service", "system"] }).notNull(),
  actor_id: text("actor_id").notNull(),
  action: text("action").notNull(),
  resource_type: text("resource_type").notNull(),
  resource_id: text("resource_id"),
  outcome: text("outcome", { enum: ["success", "denied", "failure"] }).notNull(),
  reason_code: text("reason_code"),
  metadata: jsonb("metadata").notNull(),
  request_id: text("request_id"),
  occurred_at: utc("occurred_at").notNull(),
  previous_event_hash: text("previous_event_hash"),
  event_hash: text("event_hash").notNull(),
});

export const audit_chain_heads = pgTable("audit_chain_heads", {
  organization_id: uuid("organization_id").primaryKey(),
  latest_event_id: uuid("latest_event_id"),
  latest_event_hash: text("latest_event_hash"),
  updated_at: utc("updated_at").notNull().defaultNow(),
});
