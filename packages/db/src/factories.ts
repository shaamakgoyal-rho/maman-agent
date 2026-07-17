import { uuidv7 } from "@maman/contracts";
import type { NewOrganization, NewPattern, NewRecommendation, NewUser } from "./repositories.js";

/** Deterministic-friendly test factories. Override any field via `overrides`. */

let seq = 0;
const next = () => ++seq;

export function orgFactory(overrides: Partial<NewOrganization> = {}): NewOrganization {
  const n = next();
  return {
    id: uuidv7(),
    workos_organization_id: `org_test_${n}_${uuidv7().slice(0, 8)}`,
    name: `Test Org ${n}`,
    status: "active",
    default_timezone: "America/Los_Angeles",
    ...overrides,
  };
}

export function userFactory(overrides: Partial<NewUser> = {}): NewUser {
  const n = next();
  return {
    id: uuidv7(),
    workos_user_id: `user_test_${n}_${uuidv7().slice(0, 8)}`,
    email: `user${n}@test.example`,
    display_name: `Test User ${n}`,
    ...overrides,
  };
}

export function patternFactory(
  base: { organization_id: string; owner_user_id: string },
  overrides: Partial<NewPattern> = {},
): NewPattern {
  return {
    id: uuidv7(),
    organization_id: base.organization_id,
    owner_user_id: base.owner_user_id,
    local_pattern_id: uuidv7(),
    generalized_intent: "reconcile_account_list",
    app_categories: ["crm", "spreadsheet"],
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 660_000,
    similarity_mean: "0.90000",
    projected_minutes_saved_weekly: "45.00",
    opportunity_score: "0.72000",
    risk_score: "0.20000",
    share_status: "private",
    status: "eligible",
    summary_payload: {},
    ...overrides,
  };
}

export function recommendationFactory(
  base: { organization_id: string; owner_user_id: string; pattern_id: string },
  overrides: Partial<NewRecommendation> = {},
): NewRecommendation {
  return {
    id: uuidv7(),
    organization_id: base.organization_id,
    owner_user_id: base.owner_user_id,
    pattern_id: base.pattern_id,
    title: "Reconcile account lists with Salesforce",
    summary: "Noticed a repeated reconciliation workflow.",
    evidence_payload: {
      occurrence_count: 6,
      distinct_day_count: 3,
      median_duration_ms: 660_000,
      redacted_steps: [],
    },
    confidence: "0.80000",
    risk_level: "medium",
    projected_minutes_saved_weekly: "45.00",
    expected_cost_low: "0.050000",
    expected_cost_high: "0.250000",
    required_capabilities: ["local.parse_csv", "salesforce.query_records"],
    status: "new",
    ...overrides,
  };
}
