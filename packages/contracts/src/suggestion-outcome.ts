import { z } from "zod";
import { schemaVersion1, utcTimestamp, uuid } from "./common.js";
import { packIdentifier } from "./workflow-event.js";

/**
 * A surfacing outcome plus the context it happened in (Layer 5). Written to the
 * local `suggestion_outcomes` table on every material decision a user makes
 * about a card, and nowhere else — this ledger stays on the device.
 *
 * PRIVACY SHAPE (enforced by this schema, not by convention): ids, pack
 * taxonomy identifiers, enums and small integers only. There is deliberately no
 * field that can carry a label, a window title, an account name, or any other
 * captured content — so the future learned-surfacing training set (the deferred
 * WS4 pipeline) cannot become a content leak by accident.
 */

export const suggestionOutcomeAction = z.enum([
  "accepted",
  "snoozed",
  "dismissed",
  "never_suggest",
  "wrong",
]);
export type SuggestionOutcomeAction = z.infer<typeof suggestionOutcomeAction>;

/** Why a card was dismissed. A closed vocabulary — never free text. */
export const suggestionDismissalReason = z.enum([
  "not_useful",
  "wrong_pattern",
  "too_risky",
  "not_now",
  "never_suggest",
  "other",
]);
export type SuggestionDismissalReason = z.infer<typeof suggestionDismissalReason>;

/** Where a date sits relative to the fiscal close. Low-cardinality by design. */
export const cadencePhaseSchema = z.enum(["pre_close", "in_close", "mid_period"]);

export const suggestionOutcomeSchema = z
  .object({
    schema_version: schemaVersion1,
    outcome_id: uuid,
    pattern_id: z.string().min(1).max(128),
    /** Pack workflow id (the family), or null for a novel non-template pattern. */
    workflow_id: packIdentifier.nullable(),
    pack_domain: packIdentifier.nullable(),
    cadence: z
      .enum(["continuous", "fiscal_monthly", "weekly", "date_driven", "event_driven"])
      .nullable(),
    surface: z
      .enum(["pre_close", "on_trigger", "same_weekday_observed", "after_verification"])
      .nullable(),
    outcome: suggestionOutcomeAction,
    reason: suggestionDismissalReason.nullable(),
    /** Local weekday 0–6 (Sunday = 0) and hour 0–23 the decision was made. */
    local_dow: z.number().int().min(0).max(6),
    local_hour: z.number().int().min(0).max(23),
    cadence_phase: cadencePhaseSchema.nullable(),
    /** Seconds between the card becoming due and the user acting on it. */
    seconds_since_trigger: z.number().int().min(0).nullable(),
    occurred_at: utcTimestamp,
  })
  .strict();

export type SuggestionOutcome = z.infer<typeof suggestionOutcomeSchema>;
