import { classifyEvent, SHIPPED_PACKS } from "@maman/domain-packs";
import { uuidv7, workflowEventSchema, type WorkflowEvent } from "@maman/contracts";
import { mulberry32 } from "./reconciliation.js";

/**
 * ONE repetition of the finops `three_way_match` pack workflow, shaped like
 * live observation (point-in-time events, no raw values).
 *
 * The `classification` on each event is computed by the REAL domain classifier
 * against the shipped packs — not hand-written — so the demo exercises the
 * same L1 mapping the Rust core applies at ingest, and the two can never tell
 * different stories. (Under Tauri the Rust classifier recomputes it from the
 * same inputs; in the web preview the projection reads it from the event.)
 */

export type DomainRepOptions = {
  rep_index: number;
  base_at_ms: number;
  device_id?: string;
  user_id?: string;
  organization_id?: string;
};

// Reps are spaced past the default 10-minute episode boundary: real invoice
// work recurs across a day, not back-to-back, and the template arc must work
// under PRODUCTION segmentation, not only under the live-demo preset.
const REP_SPACING_MS = 11 * 60_000;
const STEP_SPACING_MS = 15_000;

type DomainStep = {
  event_type: WorkflowEvent["event_type"];
  role?: string;
  semantic_type?: string;
  object_type: string;
};

/** Mirrors finops three_way_match: open invoice → open PO → match → flag. */
const THREE_WAY_STEPS: DomainStep[] = [
  { event_type: "record_opened", role: "row", semantic_type: "invoice", object_type: "invoice" },
  {
    event_type: "record_opened",
    role: "row",
    semantic_type: "purchase_order",
    object_type: "purchase_order",
  },
  {
    event_type: "table_read",
    role: "table",
    semantic_type: "invoice_match",
    object_type: "invoice",
  },
  {
    event_type: "value_committed",
    role: "button",
    semantic_type: "invoice_exception",
    object_type: "invoice",
  },
];

export function finopsThreeWayRepFixture(options: DomainRepOptions): WorkflowEvent[] {
  const {
    rep_index,
    base_at_ms,
    device_id = "00000000-0000-7000-8000-00000000d002",
    user_id = "00000000-0000-7000-8000-000000000001",
    organization_id = "00000000-0000-7000-8000-000000000002",
  } = options;
  const rand = mulberry32(0xf1a0 + rep_index);
  const start = base_at_ms + rep_index * REP_SPACING_MS;

  return THREE_WAY_STEPS.map((step, i) => {
    const t = start + i * STEP_SPACING_MS;
    // The real classifier, on the same evidence the event carries.
    const classification = classifyEvent(SHIPPED_PACKS, {
      app_category: "erp",
      event_type: step.event_type,
      ...(step.role ? { target_role: step.role } : {}),
      ...(step.semantic_type ? { semantic_type: step.semantic_type } : {}),
      object_type: step.object_type,
    });
    return workflowEventSchema.parse({
      schema_version: 1,
      event_id: uuidv7({ timestampMs: t, random: rand }),
      device_id,
      user_id,
      organization_id,
      occurred_at: new Date(t).toISOString(),
      monotonic_ms: rep_index * REP_SPACING_MS + i * STEP_SPACING_MS + 1000,
      source: "chrome",
      app: { display_name: "NetSuite", domain: "app.netsuite.example" },
      event_type: step.event_type,
      target: {
        ...(step.role ? { role: step.role } : {}),
        ...(step.semantic_type ? { semantic_type: step.semantic_type } : {}),
        stable_id_hash: `h_${step.event_type}_${step.role ?? "none"}`,
      },
      context: { object_type: step.object_type },
      ...(classification
        ? {
            classification: {
              domain: classification.domain,
              ...(classification.object ? { object: classification.object } : {}),
              ...(classification.action ? { action: classification.action } : {}),
              confidence: classification.confidence,
            },
          }
        : {}),
      sensitivity: "internal",
      redaction: { applied: false, reasons: [] },
    } satisfies WorkflowEvent);
  });
}

/**
 * Mirrors finops `month_end_accruals` — a FISCAL_MONTHLY workflow, which is
 * what makes the Layer 5 pre-close arc drivable: continuous workflows like
 * three_way_match have no calendar to schedule against.
 *
 * Each step's `app_category` differs (close management → ERP) because that is
 * how the work actually happens, and the classifier reads it as evidence.
 */
const MONTH_END_STEPS: Array<DomainStep & { app_category: string }> = [
  {
    app_category: "close_management",
    event_type: "record_opened",
    role: "row",
    semantic_type: "close_task",
    object_type: "close_task",
  },
  {
    app_category: "erp",
    event_type: "table_read",
    role: "table",
    semantic_type: "accrual",
    object_type: "accrual",
  },
  {
    app_category: "erp",
    event_type: "value_committed",
    role: "button",
    semantic_type: "journal_post",
    object_type: "accrual",
  },
];

export function finopsMonthEndRepFixture(options: DomainRepOptions): WorkflowEvent[] {
  const {
    rep_index,
    base_at_ms,
    device_id = "00000000-0000-7000-8000-00000000d002",
    user_id = "00000000-0000-7000-8000-000000000001",
    organization_id = "00000000-0000-7000-8000-000000000002",
  } = options;
  const rand = mulberry32(0xf2b0 + rep_index);
  const start = base_at_ms + rep_index * REP_SPACING_MS;

  return MONTH_END_STEPS.map((step, i) => {
    const t = start + i * STEP_SPACING_MS;
    // The REAL classifier, on the evidence the event carries — never hand-set.
    // It resolves these to (close_task, extract_field) and (accrual, …); the L2
    // matcher's plausible-action rule reconciles that with the pack signature's
    // `open` / `post_journal`, so nothing here is choreographed to fit.
    const classification = classifyEvent(SHIPPED_PACKS, {
      app_category: step.app_category,
      event_type: step.event_type,
      ...(step.role ? { target_role: step.role } : {}),
      ...(step.semantic_type ? { semantic_type: step.semantic_type } : {}),
      object_type: step.object_type,
    });
    return workflowEventSchema.parse({
      schema_version: 1,
      event_id: uuidv7({ timestampMs: t, random: rand }),
      device_id,
      user_id,
      organization_id,
      occurred_at: new Date(t).toISOString(),
      monotonic_ms: rep_index * REP_SPACING_MS + i * STEP_SPACING_MS + 1000,
      source: "chrome",
      app: { display_name: "NetSuite", domain: "app.netsuite.example" },
      event_type: step.event_type,
      target: {
        ...(step.role ? { role: step.role } : {}),
        ...(step.semantic_type ? { semantic_type: step.semantic_type } : {}),
        stable_id_hash: `h_me_${step.event_type}_${step.role ?? "none"}`,
      },
      context: { object_type: step.object_type },
      ...(classification
        ? {
            classification: {
              domain: classification.domain,
              ...(classification.object ? { object: classification.object } : {}),
              ...(classification.action ? { action: classification.action } : {}),
              confidence: classification.confidence,
            },
          }
        : {}),
      sensitivity: "internal",
      redaction: { applied: false, reasons: [] },
    } satisfies WorkflowEvent);
  });
}
