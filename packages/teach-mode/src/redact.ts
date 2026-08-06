import { looksLikeSecret, type MaskRegion, type TeachModeSession } from "@maman/contracts";

/**
 * The gate every captured frame passes before it may leave the device.
 *
 * This is the most safety-critical code in the Teach Mode path, and it exists
 * because of what the pixel-egress decision did NOT waive. "Secret material never
 * enters logs, analytics, prompts, or AgentSpec" is unchanged, and a frame is now
 * prompt content. So this decides two things, in this order:
 *
 *   1. May this frame be sent AT ALL? (context: which app, which session, what
 *      state the machine is in)
 *   2. If so, which regions must be painted over first?
 *
 * IT FAILS CLOSED. Every unknown, every absent piece of context, and every
 * unrecognised app resolves to "do not send". The cost of refusing a frame is that
 * Teach Mode learns slightly less from that moment; the cost of the opposite
 * mistake is a password, a card number, or a customer's record leaving the machine.
 * Those are not comparable, so the code does not treat them as though they were.
 */

/** Text on screen that the on-device OCR pass found, with where it was. */
export interface TextRegion {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when the OS reports this as a secure input (password fields). */
  secure?: boolean;
}

/** Everything known about the machine at the moment the frame was grabbed. */
export interface FrameContext {
  /** The session the user started. Absent means no session — refuse. */
  session?: TeachModeSession;
  /** Foreground app's bundle id. Absent means unknown — refuse. */
  bundleId?: string;
  /** Seconds since the session started, for the self-terminating box. */
  elapsedSeconds: number;
  /** The user paused observation. */
  paused: boolean;
  /** Hard-denied apps: keychains, password managers. Never observed at all. */
  hardDeniedBundleIds: readonly string[];
  /** Apps the user marked private, plus Maman's own bundle id. */
  privateBundleIds: readonly string[];
  /** A private/incognito browser window is in front. */
  privateBrowsing: boolean;
  /** A secure input has keyboard focus. */
  secureFieldFocused: boolean;
  /** What the on-device OCR pass read. Used only to decide what to mask. */
  textRegions: readonly TextRegion[];
}

export type EgressRefusal =
  /** No Teach Mode session is running. Capture requires one; there is no default. */
  | "no_session"
  /** The session's own time box elapsed. */
  | "session_expired"
  /** The user paused observation. */
  | "paused"
  /** The foreground app could not be identified. */
  | "unknown_app"
  /** Keychain, password manager, or another always-off app. */
  | "hard_denied_app"
  /** An app the user marked private — including Maman itself. */
  | "private_app"
  /** Incognito. Never observed, so never captured. */
  | "private_browsing"
  /** A password field has focus; the whole frame is withheld, not just masked. */
  | "secure_field_focused"
  /** The app is not one the user chose to demonstrate in. */
  | "out_of_session_scope"
  /**
   * More of the frame would have to be masked than left visible. A frame that is
   * mostly redaction is not worth the risk of the part that was missed.
   */
  | "too_much_would_be_masked";

export type EgressDecision =
  { send: true; masks: MaskRegion[] } | { send: false; reason: EgressRefusal };

/**
 * Fraction of a frame's text regions that may be masked before the frame is
 * withheld entirely.
 *
 * The reasoning is about what a high mask count implies: it means this screen is
 * full of credential-shaped material, so the chance that the pass ALSO missed
 * something is at its highest exactly there.
 */
export const MAX_MASKED_FRACTION = 0.5;

/**
 * Field labels that indicate a credential even when the OS did not mark the input
 * secure — a custom-rendered login form, a token field in a developer tool.
 *
 * This list is a floor and not the mechanism: it catches the LABEL, while
 * `looksLikeSecret` catches the VALUE. Anything matching either is masked.
 */
const CREDENTIAL_LABEL =
  /pass(word|wd|phrase)?|\bpwd\b|secret|api[\s_-]?key|token|\botp\b|\bmfa\b|2fa|auth|credential|private[\s_-]?key|seed[\s_-]?phrase|recovery[\s_-]?code|\bcvv\b|\bcvc\b|card[\s_-]?number|\bssn\b|sort[\s_-]?code|routing[\s_-]?number|\biban\b/i;

/** Password-manager and keychain UI, which is never part of the app's own form. */
const PASSWORD_MANAGER_HINT =
  /1password|lastpass|bitwarden|dashlane|keeper|nordpass|keychain access|authenticator/i;

function isCredentialish(region: TextRegion): MaskRegion["reason"] | null {
  if (region.secure === true) return "secure_field";
  if (PASSWORD_MANAGER_HINT.test(region.text)) return "password_manager_ui";
  // The VALUE looks like a credential (an API key, a JWT, a private key block).
  if (looksLikeSecret(region.text)) return "secret_shaped_text";
  // The LABEL says credential even though nothing else did.
  if (CREDENTIAL_LABEL.test(region.text)) return "unrecognised_credential_field";
  return null;
}

/** Regions that must be painted over before a frame may leave the device. */
export function maskRegionsFor(regions: readonly TextRegion[]): MaskRegion[] {
  const masks: MaskRegion[] = [];
  for (const region of regions) {
    const reason = isCredentialish(region);
    if (reason === null) continue;
    masks.push({
      x: Math.max(0, Math.trunc(region.x)),
      y: Math.max(0, Math.trunc(region.y)),
      width: Math.max(1, Math.trunc(region.width)),
      height: Math.max(1, Math.trunc(region.height)),
      reason,
    });
  }
  return masks;
}

/**
 * May this frame leave the device, and what must be covered first?
 *
 * Checks run cheapest-and-most-decisive first, so a refusal reports the strongest
 * reason rather than the most specific, and a frame from a hard-denied app is never
 * inspected closely enough to learn anything about it.
 */
export function frameEgressDecision(context: FrameContext): EgressDecision {
  const refuse = (reason: EgressRefusal): EgressDecision => ({ send: false, reason });

  // 1. A session must exist. Capture is never implicit.
  const session = context.session;
  if (session === undefined) return refuse("no_session");

  // 2. The box is self-terminating; an over-running session is not a session.
  if (context.elapsedSeconds >= session.max_seconds) return refuse("session_expired");

  if (context.paused) return refuse("paused");

  // 3. Unknown app → refuse. Every later check keys off identity, so without it
  //    there is nothing to check and no basis for sending.
  const bundleId = context.bundleId;
  if (bundleId === undefined || bundleId.trim() === "") return refuse("unknown_app");

  if (context.hardDeniedBundleIds.includes(bundleId)) return refuse("hard_denied_app");
  // Includes Maman's own bundle id, so it can never film itself demonstrating.
  if (context.privateBundleIds.includes(bundleId)) return refuse("private_app");
  if (context.privateBrowsing) return refuse("private_browsing");

  // 4. A focused password field withholds the WHOLE frame rather than masking a
  //    rectangle: what is being typed may well be rendered somewhere the mask
  //    misses, such as a "show password" reveal or a validation message.
  if (context.secureFieldFocused) return refuse("secure_field_focused");

  // 5. Starting a session in Salesforce is not consent to film everything else.
  if (!session.scope_bundle_ids.includes(bundleId)) return refuse("out_of_session_scope");

  const masks = maskRegionsFor(context.textRegions);
  if (
    context.textRegions.length > 0 &&
    masks.length / context.textRegions.length > MAX_MASKED_FRACTION
  ) {
    return refuse("too_much_would_be_masked");
  }

  return { send: true, masks };
}
