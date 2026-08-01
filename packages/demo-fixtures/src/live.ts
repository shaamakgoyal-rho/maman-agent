import { uuidv7, workflowEventSchema, type WorkflowEvent } from "@maman/contracts";
import { mulberry32 } from "./reconciliation.js";

/**
 * ONE repetition of a live CRM workflow, shaped exactly as the Chrome relay
 * records it: point-in-time events (NO duration_ms — live sources never emit
 * one), field edits as value_committed carrying only the field's semantic
 * type, and context derived from the page URL (object/page type only). Used
 * by the Home "Simulate live workflow rep" demo button and the live e2e
 * journey so the live arc is drivable without a paired extension.
 *
 * Deterministic given (rep_index, base_at_ms). Repetitions are laid out
 * back-to-back on a synthetic timeline: rep N starts at base + N * 95s, with
 * 15s between events — inside the Live-demo preset's 90s run boundary, so the
 * reps only separate via the restart splitter, like real back-to-back work.
 */

export type LiveRepOptions = {
  rep_index: number;
  base_at_ms: number;
  device_id?: string;
  user_id?: string;
  organization_id?: string;
};

const REP_SPACING_MS = 95_000;
const STEP_SPACING_MS = 15_000;

type LiveStep = {
  event_type: WorkflowEvent["event_type"];
  role?: string;
  semantic_type?: string;
  object_type?: string;
  page_type?: string;
};

const LIVE_REP_STEPS: LiveStep[] = [
  { event_type: "navigation", object_type: "account", page_type: "record" },
  { event_type: "element_activated", role: "searchbox", object_type: "account" },
  {
    event_type: "value_committed",
    role: "input",
    semantic_type: "account_name",
    object_type: "account",
  },
  {
    event_type: "value_committed",
    role: "input",
    semantic_type: "account_phone",
    object_type: "account",
  },
];

export function liveWorkflowRepFixture(options: LiveRepOptions): WorkflowEvent[] {
  const {
    rep_index,
    base_at_ms,
    device_id = "00000000-0000-7000-8000-00000000d001",
    user_id = "00000000-0000-7000-8000-000000000001",
    organization_id = "00000000-0000-7000-8000-000000000002",
  } = options;
  const rand = mulberry32(0x11fe + rep_index);
  const start = base_at_ms + rep_index * REP_SPACING_MS;

  return LIVE_REP_STEPS.map((step, i) => {
    const t = start + i * STEP_SPACING_MS;
    return workflowEventSchema.parse({
      schema_version: 1,
      event_id: uuidv7({ timestampMs: t, random: rand }),
      device_id,
      user_id,
      organization_id,
      occurred_at: new Date(t).toISOString(),
      monotonic_ms: rep_index * REP_SPACING_MS + i * STEP_SPACING_MS + 1000,
      source: "chrome",
      app: { display_name: "Salesforce", domain: "acme.lightning.force.com" },
      event_type: step.event_type,
      target: {
        ...(step.role ? { role: step.role } : {}),
        ...(step.semantic_type ? { semantic_type: step.semantic_type } : {}),
        stable_id_hash: `h_${step.event_type}_${step.role ?? "none"}`,
      },
      context: {
        ...(step.page_type ? { page_type: step.page_type } : {}),
        ...(step.object_type ? { object_type: step.object_type } : {}),
      },
      // No duration_ms — the defining property of live relay events.
      sensitivity: "internal",
      redaction: { applied: false, reasons: [] },
    } satisfies WorkflowEvent);
  });
}
