import { z } from "zod";
import { appCategory, nonSecretString, schemaVersion1, utcTimestamp, uuid } from "./common.js";

/**
 * THE LOCAL ACTION TRACE — the second observation layer, and the reason Maman
 * can stop asking the user to re-describe work it already watched.
 *
 * `WorkflowEvent` (workflow-event.ts) is a deliberately LOSSY projection: source,
 * app category, event type, role, semantic type, object type. It is enough to
 * notice that something repeats and nowhere near enough to reproduce it — which
 * is exactly why the product used to hand the user a form asking which site,
 * which field, which label, which value, after supposedly having learned the
 * workflow. That form was the bill for the missing layer.
 *
 * This layer is the missing one. It keeps, LOCALLY AND ENCRYPTED, the things a
 * replay actually needs: which app, which origin, which control, which menu
 * path, which step's output feeds which later step.
 *
 * THE RULES THAT MAKE IT SAFE — enforced structurally, not by convention:
 *
 *  1. NO RAW VALUES, EVER. A step never carries the text that was typed. It
 *     carries a BINDING: an earlier step's output, a runtime input slot the pet
 *     asks about, or an opaque `encrypted_ref` to a locally-encrypted constant.
 *     There is no schema field a value could sit in, so "we forgot to redact"
 *     is not a reachable state — and `containsForbiddenEventField` keeps
 *     passing over a whole trace.
 *  2. NO KEYSTROKE STREAMS. The unit is a COMMITTED action ("this control ended
 *     up holding a value from that source"), never the typing that produced it.
 *     Nothing in this file can represent a key event.
 *  3. PROTECTED SEGMENTS ARE HOLES, NOT CONTENT. When observation crossed a
 *     secure field, password manager, payment or auth flow, or private browsing,
 *     the trace records THAT A GAP EXISTS and its reason — never what was in it,
 *     and for a hard-denied surface not even which app it was.
 *  4. LOCAL ONLY, in the type. `local_only: true` is a literal, so a trace
 *     cannot be constructed in a shape the sync path would accept; the outbox
 *     serializes `WorkflowEvent`s, and this is not one.
 *  5. LABELS ARE HASHED unless they are already safe to keep. A control's
 *     accessible name is often a field label ("Phone") — kept as
 *     `nonSecretString` so it can address the control — while window titles and
 *     document names, which routinely carry customer names, are kept as hashes.
 *
 * A trace is written by the observer layer, read by the compiler, and shown to
 * the user only as plain-language steps. It never enters analytics, logs, model
 * prompts, or the React layer.
 */

/** Where an action happened — the adapter family that can reproduce it. */
export const traceSurface = z.enum([
  "browser_dom",
  "macos_ax",
  "applescript",
  "shortcut",
  "command",
  "vision",
]);
export type TraceSurface = z.infer<typeof traceSurface>;

/**
 * A hashed label. Window titles and document names carry customer data as a
 * matter of course, so they are fingerprints: comparable across runs, unreadable.
 */
export const labelHash = z.string().regex(/^[a-f0-9]{64}$/, "expected a sha256 hex digest");

/**
 * HOW TO FIND THE CONTROL AGAIN — the part coarse observation threw away.
 *
 * Deliberately several weak signals rather than one strong one: a DOM locator
 * survives a re-render but not a redesign, an accessible name survives a
 * redesign but not a relabel, and ancestry disambiguates two controls that share
 * a name. The adapter decides which to trust; the trace records what was true.
 */
export const stableTarget = z
  .object({
    /** AX/ARIA role ("textbox", "button", "row"). The one near-stable signal. */
    role: nonSecretString,
    /**
     * The control's visible label, when it is a label and not data —
     * "Phone", "Save", "Account Name". Refused if it looks like a secret.
     */
    accessible_name: nonSecretString.optional(),
    /** Stable developer identifier (AX identifier, DOM id/name, test id). */
    identifier: nonSecretString.optional(),
    /** Enclosing roles/labels, outermost first, for disambiguation. */
    ancestry: z.array(nonSecretString).max(12).default([]),
    /** Menu path for a menu action ("File" → "Export…"). Labels, not data. */
    menu_path: z.array(nonSecretString).max(8).default([]),
    /** The window this lived in, hashed — titles carry customer names. */
    window_title_hash: labelHash.optional(),
    /** Nth match when a name is genuinely ambiguous. A last resort. */
    index_hint: z.number().int().nonnegative().optional(),
    /**
     * Screen anchor for the vision surface ONLY, and never a bare coordinate:
     * a text/role anchor the adapter re-locates. Blind coordinate replay is
     * what makes visual automation a liability.
     */
    visual_anchor: nonSecretString.optional(),
  })
  .strict();
export type StableTarget = z.infer<typeof stableTarget>;

/**
 * WHERE A VALUE COMES FROM — the whole point of the layer.
 *
 * The four kinds are exhaustive on purpose. There is no fifth kind that means
 * "the literal text the user typed", because that is the thing this model exists
 * not to keep.
 */
export const valueBinding = z.discriminatedUnion("kind", [
  /** Copied from an earlier step's output — the copy/paste edge, recovered. */
  z
    .object({
      kind: z.literal("from_step"),
      step: z.number().int().positive(),
      output: nonSecretString,
    })
    .strict(),
  /**
   * Nobody can infer this one, so the agent carries a slot and the pet asks
   * once, inline, at the moment the value is needed. This is what makes a
   * one-click agent still one click when a value is missing.
   */
  z
    .object({
      kind: z.literal("runtime_input"),
      input_id: nonSecretString,
      /** What to ask, in the user's words. Never contains an example value. */
      prompt: nonSecretString,
    })
    .strict(),
  /**
   * A value stable across runs and safe to keep (a fiscal period, a fixed
   * account). Stored encrypted; this is an opaque handle, not the value, and it
   * is never synced.
   */
  z.object({ kind: z.literal("local_constant"), encrypted_ref: uuid }).strict(),
  /** The action carries no value at all (a click, a navigation). */
  z.object({ kind: z.literal("none") }).strict(),
]);
export type ValueBinding = z.infer<typeof valueBinding>;

/** What had to be true before the action, so a replay can refuse when it isn't. */
export const preconditions = z
  .object({
    app_bundle_id: nonSecretString.optional(),
    origin: nonSecretString.optional(),
    /** "/leads/:id" — the shape of the location, never the identifier itself. */
    path_template: nonSecretString.optional(),
    focused_window_title_hash: labelHash.optional(),
    /**
     * The control's value before the action, as an encrypted ref. Optimistic
     * concurrency: a replay compares, and aborts when the page moved on.
     */
    expect_current_ref: uuid.optional(),
    /** A UI action into a background window is a lie about what happened. */
    requires_foreground: z.boolean().default(false),
    /** Consequential writes only run while somebody is there to see them. */
    requires_user_presence: z.boolean().default(false),
  })
  .strict();
export type Preconditions = z.infer<typeof preconditions>;

/** What the action was observed to achieve, and how to check it independently. */
export const expectedEffect = z
  .object({
    kind: z.enum([
      "value_committed",
      "row_added",
      "navigated",
      "file_written",
      "message_sent",
      "record_updated",
      "none",
    ]),
    /**
     * How to confirm it happened — a FRESH read, not the write's own return
     * value. "The click returned ok" is not verification.
     */
    readback: z.enum(["reread_target", "reread_list", "reread_file", "none"]).default("none"),
  })
  .strict();
export type ExpectedEffect = z.infer<typeof expectedEffect>;

/** One reproducible step. */
export const observedAction = z
  .object({
    order: z.number().int().positive(),
    surface: traceSurface,
    app_bundle_id: nonSecretString.optional(),
    origin: nonSecretString.optional(),
    path_template: nonSecretString.optional(),
    /** Adapter-neutral verb: "set_value", "press", "select", "navigate", … */
    operation: nonSecretString,
    target: stableTarget,
    value_binding: valueBinding.default({ kind: "none" }),
    preconditions: preconditions.default({
      requires_foreground: false,
      requires_user_presence: false,
    }),
    expected_effect: expectedEffect.optional(),
  })
  .strict();
export type ObservedAction = z.infer<typeof observedAction>;

/**
 * A GAP, AND WHY. The trace says a hole exists so the compiler can refuse to
 * pretend it understood a workflow it only half saw — and so a user reading
 * "Why this?" sees that Maman looked away rather than that nothing happened.
 */
export const protectedSegment = z
  .object({
    started_at: utcTimestamp,
    ended_at: utcTimestamp,
    reason: z.enum([
      "secure_field",
      "password_manager",
      "private_browsing",
      "payment_flow",
      "auth_flow",
      "hard_denied_app",
      "user_denied",
      "observation_paused",
    ]),
    /**
     * Present only when naming the app is itself safe (a user-denied app the
     * user chose). Absent for hard-denied surfaces: "which bank" is the fact
     * being protected.
     */
    app_category: appCategory.optional(),
  })
  .strict();
export type ProtectedSegment = z.infer<typeof protectedSegment>;

/** One app or site the trace passed through. */
export const appSurface = z
  .object({
    category: appCategory,
    bundle_id: nonSecretString.optional(),
    origin: nonSecretString.optional(),
    /** Display name hashed — an app name can be a customer's product name. */
    display_name_hash: labelHash.optional(),
  })
  .strict();
export type AppSurface = z.infer<typeof appSurface>;

/**
 * ONE REPRODUCIBLE ROUTINE, as observed. Local only, encrypted at rest.
 *
 * `pattern_event_refs` is the join to the mining projection: detection keeps
 * running on `PatternFeatureEvent`s (cheap, lossy, safe to reason about in
 * bulk), and the compiler follows the reference to the trace that can actually
 * be replayed. One direction only — the events point at a trace; the trace never
 * leaks into them.
 */
export const localActionTrace = z
  .object({
    schema_version: schemaVersion1,
    trace_id: uuid,
    started_at: utcTimestamp,
    ended_at: utcTimestamp,
    apps: z.array(appSurface).min(1).max(24),
    steps: z.array(observedAction).min(1).max(200),
    protected_segments: z.array(protectedSegment).max(64).default([]),
    /** The mining events this trace explains. */
    pattern_event_refs: z.array(uuid).max(400).default([]),
    /**
     * A literal, not a flag: there is no `false` a sync payload could carry, so
     * a trace cannot be shaped into something the outbox would accept.
     */
    local_only: z.literal(true),
  })
  .strict();
export type LocalActionTrace = z.infer<typeof localActionTrace>;

/**
 * Field names that must never appear inside a trace, on top of the WorkflowEvent
 * list. A trace legitimately carries locators, so the guard cannot simply be
 * "no strings" — it is "no field that could hold what was typed or who it was
 * about". `value` is included: a binding is `value_binding`, and a bare `value`
 * key means somebody inlined the thing this model exists to avoid.
 */
export const FORBIDDEN_TRACE_FIELDS = [
  "value",
  "text",
  "typed",
  "keystrokes",
  "key_code",
  "clipboard",
  "password",
  "passcode",
  "otp",
  "one_time_code",
  "token",
  "cookie",
  "secret",
  "card_number",
  "cvv",
  "authorization",
  "screenshot",
  "frame",
  "jpeg_b64",
  "window_title",
  "document_title",
] as const;

/**
 * Deep-scan a trace payload before it is persisted. Returns the offending field
 * name, or null. Defense in depth: the schema is `.strict()`, so an extra field
 * already fails parsing — this catches the case where a future field is added
 * with a dangerous name and a passing test.
 */
export function containsForbiddenTraceField(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = containsForbiddenTraceField(item);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
    if ((FORBIDDEN_TRACE_FIELDS as readonly string[]).includes(key.toLowerCase())) return key;
    const nested = containsForbiddenTraceField(val);
    if (nested) return nested;
  }
  return null;
}

/**
 * Parse + safety gate in one call. Use this at EVERY boundary that persists a
 * trace, so no call site can validate the shape and skip the field scan.
 */
export function parseLocalActionTrace(
  payload: unknown,
): { ok: true; trace: LocalActionTrace } | { ok: false; reason: string } {
  const forbidden = containsForbiddenTraceField(payload);
  if (forbidden) return { ok: false, reason: `forbidden field in trace: ${forbidden}` };
  const parsed = localActionTrace.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid trace" };
  }
  return { ok: true, trace: parsed.data };
}

/**
 * Whether a trace is replayable at all: every step needs a resolvable value, and
 * a `from_step` binding must point at an EARLIER step (a cycle is not a
 * workflow). Steps whose value nobody can supply are reported so the compiler
 * turns them into runtime input slots rather than guessing.
 */
export function traceReadiness(trace: LocalActionTrace): {
  ready: boolean;
  runtime_inputs: string[];
  problems: string[];
} {
  const problems: string[] = [];
  const runtime_inputs: string[] = [];
  const orders = new Set(trace.steps.map((s) => s.order));
  if (orders.size !== trace.steps.length) problems.push("duplicate step order");

  for (const step of trace.steps) {
    const binding = step.value_binding;
    if (binding.kind === "from_step") {
      if (binding.step >= step.order) {
        problems.push(`step ${step.order} reads from a later step (${binding.step})`);
      } else if (!orders.has(binding.step)) {
        problems.push(`step ${step.order} reads from a missing step (${binding.step})`);
      }
    }
    if (binding.kind === "runtime_input") runtime_inputs.push(binding.input_id);
  }
  return { ready: problems.length === 0, runtime_inputs, problems };
}
