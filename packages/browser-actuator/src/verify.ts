import { isBrowserWrite, type BrowserAction, type BrowserActionResult } from "@maman/contracts";
import { namesMatch, valuesMatch } from "./resolve.js";

/**
 * Did the write actually land?
 *
 * The capability router marks consequential browser steps `verification:
 * "independent_read"`, and this is where that is honoured. "The executor said
 * applied" is not verification — the executor is the thing being checked. What
 * counts is the value read back out of the page afterwards.
 */
export type WriteVerification =
  | { verified: true }
  | {
      verified: false;
      reason:
        /** Read-back disagrees with what was asked for. The write did not take. */
        | "value_mismatch"
        /** Executor returned nothing to check. Treated as unverified, not as fine. */
        | "no_observation"
        /**
         * A click has no read-back. Verification needs a separate `read_field`
         * against the record — which is why this is a distinct answer and not a
         * pass.
         */
        | "requires_independent_read"
        /** The action never claimed to have been applied. */
        | "not_applied"
        /** Caller passed a read; there is nothing to verify. */
        | "not_a_write";
    };

export function verifyWrite(action: BrowserAction, result: BrowserActionResult): WriteVerification {
  const fail = (reason: Exclude<WriteVerification, { verified: true }>["reason"]) => ({
    verified: false as const,
    reason,
  });

  if (!isBrowserWrite(action)) return fail("not_a_write");
  if (result.outcome !== "applied") return fail("not_applied");

  const observed = result.observed;
  if (observed === undefined) return fail("no_observation");

  if (action.kind === "click_control") {
    // Nothing about a button press is readable from the button. Confirming the
    // control's identity is the most this can do; the record itself must be re-read.
    return namesMatch(action.confirm_name, observed.resolved_name)
      ? fail("requires_independent_read")
      : fail("value_mismatch");
  }

  const intended = action.kind === "set_value" ? action.value : action.option;
  return valuesMatch(intended, observed.value_after) ? { verified: true } : fail("value_mismatch");
}
