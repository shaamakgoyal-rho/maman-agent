/**
 * THE INTENT LAYER.
 *
 * `generalized_intent` used to be a bare string — "update_account_records" — a
 * label the compiler pattern-matched on. It carried no requirements, so nothing
 * could say what an automation actually NEEDS in order to run, and the agent's
 * description degraded to "Helper: update account records": true, useless, and
 * indistinguishable from a description of any other workflow.
 *
 * An AutomationIntent replaces that label with a structure: what kind of work
 * this is, what SLOTS must be filled before it can execute, which of those the
 * agent can discover for itself by interacting with the target, and which are
 * genuinely unknowable without being told.
 *
 * The distinction between those last two is the point. Observation sees that a
 * text field changed; it never sees which field or what value. But an AGENT
 * looking at the live surface CAN see which fields exist, what they are called
 * and what they currently hold. So a locator or a field slot is DISCOVERABLE —
 * the agent resolves it by reading the page — while the value a user wants
 * written is not, and must be supplied. That reduces "teach me everything" to
 * "tell me the one thing I cannot find out", and it makes the description
 * concrete because the resolved slots name real fields on a real surface.
 *
 * Nothing here invents. A slot the agent cannot resolve stays unresolved and
 * says why; the intent does not execute until every required slot is filled.
 */

import type { BrowserTargetRole } from "@maman/contracts";

/** What kind of thing a slot holds. */
export type SlotKind =
  /** Which record/page the work happens on, e.g. an account record. */
  | "record_locator"
  /** A control to read from or write to, addressed by accessible name. */
  | "field"
  /** The content to write. */
  | "value"
  /** A control that commits the work (Save), named for confirmation. */
  | "commit_control";

/**
 * How a slot may legitimately be filled.
 *
 * `discoverable` means the agent can resolve it by OBSERVING THE LIVE SURFACE —
 * reading the fields present on the page it is already allowed to be on. It is
 * not a licence to guess: discovery either finds an unambiguous match or fails.
 *
 * `supplied` means no amount of looking will answer it. A phone number the user
 * wants written is not on the page; it is in their head.
 */
export type SlotResolution = "discoverable" | "supplied" | "either";

export interface IntentSlot {
  name: string;
  kind: SlotKind;
  /** One line the user reads when asked for, or shown, this slot. */
  description: string;
  required: boolean;
  resolution: SlotResolution;
  /**
   * Roles a discovered control may have. A slot that accepts no roles is not
   * discoverable from a surface, whatever `resolution` claims.
   */
  accepts_roles?: readonly BrowserTargetRole[];
  /**
   * Words that make a discovered field a plausible match, in the user's own
   * vocabulary ("phone", "mobile"). Matching is EXACT-or-nothing against the
   * accessible name; these only rank candidates that already matched, so a
   * hint can never conjure a field that is not there.
   */
  hints?: readonly string[];
}

/** What the agent knows, from every source, when resolving an intent. */
export interface IntentEvidence {
  /** The origin the work happens on. */
  origin?: string;
  /**
   * Controls the agent actually saw on the live surface. Empty means it has not
   * looked yet — which is different from "the page has no fields", and the
   * resolver reports the difference.
   */
  surface?: {
    looked: boolean;
    controls: ReadonlyArray<{ name: string; role: BrowserTargetRole; value?: string }>;
  };
  /** Values the user supplied, by slot name. */
  supplied?: Readonly<Record<string, string>>;
  /** Semantic types the observer recorded, when the source provided them. */
  observed_semantics?: readonly string[];
}

/** A slot that was filled, and how — provenance travels with the value. */
export interface FilledSlot {
  name: string;
  kind: SlotKind;
  /** For a field/commit slot: the control. For a value slot: the text. */
  value: string;
  role?: BrowserTargetRole;
  /** How this was determined. Shown to the user; never inferred silently. */
  source: "discovered_on_surface" | "supplied_by_user" | "from_origin";
}

/** A slot that could not be filled, and the reason in the user's language. */
export interface UnfilledSlot {
  name: string;
  kind: SlotKind;
  required: boolean;
  reason:
    "not_looked_yet" | "no_matching_control" | "ambiguous_controls" | "needs_you_to_supply_it";
  detail: string;
  /**
   * The vocabulary discovery used, when it had any. Carried out of resolution
   * because it is the difference between "I couldn't find a field" and "I
   * looked for a phone field and this page hasn't got one" — and because it
   * lets a description name the work concretely BEFORE the agent has opened
   * anything, which is when the user reads the card and decides.
   */
  looked_for?: readonly string[];
}

export interface AutomationIntent {
  intent_id: string;
  version: number;
  /** Verb phrase used to build the concrete description ("Update", "Copy"). */
  verb: string;
  /** What this automation is for, in one line. */
  purpose: string;
  slots: readonly IntentSlot[];
  /**
   * Capabilities this intent will need. Declared so readiness can be checked
   * against a runtime BEFORE anything is compiled or shown as available.
   */
  requires_capabilities: readonly string[];
  /** How success is proven. `readback` re-reads the field it wrote. */
  success: "readback" | "independent_read" | "none";
}

export interface ResolvedIntent {
  intent: AutomationIntent;
  filled: FilledSlot[];
  unfilled: UnfilledSlot[];
  /** True when every REQUIRED slot is filled. Derived, never stored. */
  executable: boolean;
}
