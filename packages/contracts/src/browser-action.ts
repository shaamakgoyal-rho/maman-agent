import { z } from "zod";
import { looksLikeSecret, utcTimestamp, uuid } from "./common.js";

/**
 * Supervised browser actuation: the desktop core asks the extension to perform ONE
 * action in a tab the user is already signed in to. This is the fallback lane for
 * systems with no public API; `packages/capability-router` prefers `api` (score 1.0)
 * over `browser_extension` (0.6) and never falls back to it automatically for a
 * consequential step.
 *
 * Four properties are structural here, not policy that a caller can opt out of:
 *
 * 1. THE ACTION SET IS CLOSED. There is no "run script", "eval", "dispatch event",
 *    or free-form selector member, and adding one would defeat every other control
 *    in this file. A compromised or hallucinated AgentSpec can only ask for one of
 *    the verbs below, against a named control, on an allow-listed origin.
 * 2. TARGETING IS BY ACCESSIBLE ROLE + NAME, not by CSS/XPath. A selector is not
 *    reviewable by the human who approves the step; "the textbox named Close date"
 *    is. Ambiguity is refused rather than guessed (see `browserActionRefusal`).
 * 3. VALUES ARE NON-SECRET AND BOUNDED. Secret material never enters logs,
 *    analytics, prompts or AgentSpec, and this wire is all four at once — it is
 *    relayed through the native host and recorded in the run receipt.
 * 4. PAGE TEXT IS DATA. Anything read out of a page arrives in
 *    `browserActionResult.observed` and is only ever compared, recorded, or shown to
 *    the user. It is never parsed for anything that could become the next action.
 */

/**
 * A length-bounded string that must not contain secret-shaped content.
 * `nonSecretString` is already refined, so it cannot carry the bounds; every
 * user-visible string on this wire needs both.
 */
const boundedNonSecret = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !looksLikeSecret(v), { message: "value matches a secret shape" });

/** Accessible roles the executor is allowed to address. */
export const browserTargetRole = z.enum([
  "textbox",
  "combobox",
  "checkbox",
  "button",
  "link",
  "cell",
  "heading",
]);
export type BrowserTargetRole = z.infer<typeof browserTargetRole>;

/**
 * One control, addressed the way a person would describe it. `name` is matched
 * against the element's accessible name (trimmed, case-insensitive).
 *
 * `nth` exists for genuinely repeated controls (a row in a table). It must be
 * stated explicitly: when it is absent and more than one control matches, the
 * executor refuses with `ambiguous_match` instead of taking the first hit.
 */
export const browserTargetSchema = z
  .object({
    role: browserTargetRole,
    name: boundedNonSecret(1, 120),
    nth: z.number().int().nonnegative().max(200).optional(),
  })
  .strict();
export type BrowserTarget = z.infer<typeof browserTargetSchema>;

/** Read-only: bring a field into view/focus so the user can see what will change. */
const focusFieldAction = z
  .object({ kind: z.literal("focus_field"), target: browserTargetSchema })
  .strict();

/** Read-only: used both to build the diff preview and to verify a write. */
const readFieldAction = z
  .object({ kind: z.literal("read_field"), target: browserTargetSchema })
  .strict();

/** Read-only: `url` is additionally checked against the request's allowed origins. */
const navigateAction = z
  .object({ kind: z.literal("navigate"), url: z.string().url().startsWith("https://") })
  .strict();

/**
 * Write. `expect_current` is optimistic concurrency, not decoration: when present,
 * the executor refuses with `precondition_failed` unless the field currently holds
 * that value. It is how a stale plan — built from a page that has since changed —
 * fails instead of overwriting someone else's edit.
 */
const setValueAction = z
  .object({
    kind: z.literal("set_value"),
    target: browserTargetSchema,
    value: boundedNonSecret(0, 512),
    expect_current: boundedNonSecret(0, 512).optional(),
  })
  .strict();

/** Write. */
const selectOptionAction = z
  .object({
    kind: z.literal("select_option"),
    target: browserTargetSchema,
    option: boundedNonSecret(1, 200),
  })
  .strict();

/**
 * Write, and the one that submits. `confirm_name` must equal the control's
 * accessible name; it is a second, independent statement of what is being pressed
 * so that a plan whose target drifted cannot silently click a different button.
 */
const clickControlAction = z
  .object({
    kind: z.literal("click_control"),
    target: browserTargetSchema,
    confirm_name: boundedNonSecret(1, 120),
  })
  .strict();

export const browserActionSchema = z.discriminatedUnion("kind", [
  navigateAction,
  readFieldAction,
  focusFieldAction,
  setValueAction,
  selectOptionAction,
  clickControlAction,
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

/** Action kinds that change the remote system. Everything else only observes. */
export const BROWSER_WRITE_KINDS = ["set_value", "select_option", "click_control"] as const;

/** The three verbs that change the remote system, as a type. */
export type BrowserWriteAction = Extract<
  BrowserAction,
  { kind: (typeof BROWSER_WRITE_KINDS)[number] }
>;

/**
 * A type predicate rather than a plain boolean so that "this is a write" narrows
 * the action everywhere it is checked. Callers that guard on it then cannot reach a
 * read's fields by accident, and vice versa.
 */
export function isBrowserWrite(action: BrowserAction): action is BrowserWriteAction {
  return (BROWSER_WRITE_KINDS as readonly string[]).includes(action.kind);
}

/**
 * A single approved step, addressed to the extension.
 *
 * `authorization` is minted by the desktop core when a human approves the step and
 * is single-use. It is why page content cannot self-trigger an action: a message
 * that did not come from the core has no valid token, and a token already spent is
 * rejected. `expires_at` bounds how long an intercepted request stays useful.
 */
export const browserActionRequestSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("browser_action_request"),
    request_id: uuid,
    run_id: uuid,
    step_id: z.string().min(1).max(120),
    action: browserActionSchema,
    /**
     * Opaque single-use token, never logged in full. Constrained to non-secret
     * shapes so a real credential cannot be pressed into service as one — an API
     * key used here would be a credential on a relayed, receipted wire.
     */
    authorization: boundedNonSecret(32, 128),
    /** Origins this step may touch, e.g. "https://example.my.salesforce.com". */
    allowed_origins: z.array(z.string().url().startsWith("https://")).min(1).max(8),
    /** Mirrors the router's classification; a write must never arrive as false. */
    consequential: z.boolean(),
    issued_at: utcTimestamp,
    expires_at: utcTimestamp,
  })
  .strict();
export type BrowserActionRequest = z.infer<typeof browserActionRequestSchema>;

export const browserActionOutcome = z.enum(["applied", "observed", "refused", "failed"]);
export type BrowserActionOutcome = z.infer<typeof browserActionOutcome>;

/**
 * Why an action was not performed. These are ordinary, expected results — a refusal
 * is the executor working, not an error to be retried or coded around. Each one is
 * surfaced to the user verbatim and recorded on the run.
 */
export const browserActionRefusal = z.enum([
  /** Target is a password/secure field, or a field the observer treats as private. */
  "secure_field",
  /** The tab's origin is not in `allowed_origins`. */
  "origin_not_allowed",
  /** Incognito/private window: never actuated, same rule as never observed. */
  "private_window",
  /** No control matched the role+name. */
  "no_match",
  /** More than one matched and the plan did not say which. */
  "ambiguous_match",
  /** Missing, malformed, expired, or already-spent authorization. */
  "not_authorized",
  /** `expect_current` did not match what the field holds now. */
  "precondition_failed",
  /** `confirm_name` disagreed with the resolved control's accessible name. */
  "confirm_name_mismatch",
  /** Target is disabled, readonly, or not editable. */
  "target_not_editable",
  /** A write arrived while the user was away from the machine. */
  "user_absent",
  /** The user paused or cancelled the run. */
  "paused_by_user",
]);
export type BrowserActionRefusal = z.infer<typeof browserActionRefusal>;

/**
 * What the page held. Page-authored text — treated as data everywhere it is used:
 * compared against an expected value, recorded on the receipt, or shown to the
 * user. It is never interpreted as an instruction and never used to choose the next
 * action.
 */
export const browserObservationSchema = z
  .object({
    /** Resolved accessible name of the control that was acted on. */
    resolved_name: boundedNonSecret(0, 120),
    /** Value before the action, when the field was readable. */
    value_before: boundedNonSecret(0, 512).optional(),
    /** Value after the action, read back independently for verification. */
    value_after: boundedNonSecret(0, 512).optional(),
    /** Count of controls that matched, so `ambiguous_match` is explainable. */
    match_count: z.number().int().nonnegative().max(1000),
    /** Origin the action ran against, for the receipt. */
    origin: z.string().url().startsWith("https://"),
  })
  .strict();
export type BrowserObservation = z.infer<typeof browserObservationSchema>;

export const browserActionResultSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("browser_action_result"),
    request_id: uuid,
    run_id: uuid,
    step_id: z.string().min(1).max(120),
    outcome: browserActionOutcome,
    refusal_reason: browserActionRefusal.optional(),
    /** Absent when the executor could not reach the page at all. */
    observed: browserObservationSchema.optional(),
    /** Free text only for `failed`; never carries page content. */
    failure: z.string().max(200).optional(),
    completed_at: utcTimestamp,
  })
  .strict()
  .refine((r) => (r.outcome === "refused") === (r.refusal_reason !== undefined), {
    message: "refusal_reason is required for refused and forbidden otherwise",
  });
export type BrowserActionResult = z.infer<typeof browserActionResultSchema>;
