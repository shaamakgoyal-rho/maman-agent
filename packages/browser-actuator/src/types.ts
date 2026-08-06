import type { BrowserActionRefusal, BrowserTargetRole } from "@maman/contracts";

/**
 * A DOM-free view of one control on the page.
 *
 * The extension's DOM adapter is responsible for filling this in; every decision
 * about whether to act is made against this shape instead of against live
 * elements. That is what makes the refusal rules testable without a browser, and
 * it keeps the adapter small enough to read in one sitting.
 */
export interface CandidateControl {
  role: BrowserTargetRole;
  /** Accessible name as computed by the adapter (aria-label, label, text). */
  accessibleName: string;
  /** Current value, when the control exposes one and is safe to read. */
  value?: string;
  /** False for disabled, readonly, or otherwise non-editable controls. */
  editable: boolean;
  /**
   * True for password and other secure inputs, and for anything the adapter
   * cannot prove is NOT secure. Defaulting to true on doubt is deliberate: the
   * cost of refusing a legitimate field is a message to the user, and the cost of
   * the other mistake is typing into a credential box.
   */
  secure: boolean;
  /** Off-screen and hidden controls are not candidates at all. */
  visible: boolean;
}

/** Everything about the tab and the user that gates an action. */
export interface PageContext {
  /** Origin of the tab, e.g. "https://example.my.salesforce.com". */
  origin: string;
  /** Incognito or otherwise private. Never observed, and never actuated. */
  privateWindow: boolean;
  /** Whether the user is at the machine right now. Gates writes only. */
  userPresent: boolean;
  /** The user has paused or cancelled the run. */
  paused: boolean;
  controls: readonly CandidateControl[];
}

/** Outcome of resolving a request against a page: act on this control, or refuse. */
export type ResolveOutcome =
  | { ok: true; control: CandidateControl; matchCount: number }
  | { ok: false; refusal: BrowserActionRefusal; matchCount: number };
