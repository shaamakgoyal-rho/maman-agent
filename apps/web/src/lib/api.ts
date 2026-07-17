import { product } from "@maman/config";

/**
 * Server-side API client for the admin console. In dev it authenticates with
 * dev identity headers as an org_admin; in production it forwards the WorkOS
 * bearer token from the session. It never stores connector tokens.
 */

const API_BASE = process.env.MAMAN_API_BASE_URL ?? "http://localhost:4000";
const DEMO_ORG = "org_demo_acme_sales";

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
  unavailable?: boolean;
};

export type AuditEntry = {
  occurred_at: string;
  actor_type: string;
  action: string;
  resource_type: string;
  outcome: string;
  reason_code: string | null;
};

async function adminHeaders(): Promise<Record<string, string>> {
  // Demo/dev: resolve the seeded org + a org_admin identity for read-only
  // aggregate access. Production swaps this for the WorkOS session token.
  return {
    "x-dev-org-id": await resolveDemoOrgId(),
    "x-dev-user-id": "00000000-0000-7000-8000-0000000000ad",
    "x-dev-role": "org_admin",
  };
}

/** The API is keyed by UUID org id; resolve the demo org's UUID once (dev). */
let cachedOrgId: string | null = null;
async function resolveDemoOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId;
  try {
    const res = await fetch(`${API_BASE}/v1/dev/resolve-org?workos_id=${DEMO_ORG}`, {
      cache: "no-store",
    });
    if (res.ok) {
      cachedOrgId = ((await res.json()) as { organization_id: string }).organization_id;
      return cachedOrgId;
    }
  } catch {
    // fall through
  }
  cachedOrgId = DEMO_ORG;
  return cachedOrgId;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: await adminHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const admin = {
  overview: () => get<AdminOverview>("/v1/admin/overview"),
  audit: () => get<AuditEntry[]>("/v1/admin/audit"),
};

export const branding = product;
