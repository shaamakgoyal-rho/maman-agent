import type {
  AutomationIntent,
  FilledSlot,
  IntentEvidence,
  IntentSlot,
  ResolvedIntent,
  UnfilledSlot,
} from "./types.js";

/**
 * Fills an intent's slots from evidence.
 *
 * The rule this whole module exists to enforce: a slot is filled only when the
 * evidence UNAMBIGUOUSLY determines it. Two candidate fields named "Phone" do
 * not resolve to the first one; they resolve to nothing, with a reason. That is
 * the same choice the page script makes when it refuses an ambiguous target,
 * and for the same reason — picking between two plausible controls is how an
 * agent types into the wrong box.
 *
 * Discovery is not inference. The agent reads the controls that are actually on
 * the surface it is already permitted to be on, and matches their accessible
 * names. It never derives a field name from a role, a semantic type, or a
 * pattern token, because none of those name a control.
 */

/**
 * Which controls on the surface could be this slot.
 *
 * Two independent narrowings, and both must be satisfied:
 *
 * - ROLE, from the intent. A button named "Phone" is not a field to type into.
 * - VOCABULARY, from the intent's hints and from what the observer recorded
 *   about the real workflow. This is what stops a lone textbox on the page from
 *   being assumed to be the field the user meant just because it is the only
 *   one — "the only candidate" and "the right one" are not the same claim.
 *
 * Vocabulary RANKS controls that already exist; it never conjures one. When
 * vocabulary is available and nothing matches it, the slot is unresolved rather
 * than falling back to "any field will do", because that fallback is exactly how
 * an agent writes into a field nobody asked it to touch.
 */
function vocabularyFor(slot: IntentSlot, observedSemantics: readonly string[]): string[] {
  // The observer's semantic types describe the real workflow, so they are
  // vocabulary about THIS automation in a way a catalog hint cannot be.
  return [...(slot.hints ?? []), ...(slot.kind === "field" ? observedSemantics : [])]
    .map((h) => h.toLowerCase())
    .filter((h) => h.length > 0 && h !== "-");
}

function matchControls(
  slot: IntentSlot,
  controls: NonNullable<IntentEvidence["surface"]>["controls"],
  vocabulary: readonly string[],
): Array<{ name: string; role: string; value?: string }> {
  const roleOk = (role: string) =>
    slot.accepts_roles === undefined || (slot.accepts_roles as readonly string[]).includes(role);

  const eligible = controls.filter((c) => roleOk(c.role));
  if (vocabulary.length === 0) return [...eligible];

  const matched = eligible.filter((c) => {
    const name = c.name.toLowerCase();
    return vocabulary.some((h) => name === h || name.includes(h));
  });
  return matched.length > 0 ? [...matched] : [];
}

function unfilled(
  slot: IntentSlot,
  reason: UnfilledSlot["reason"],
  detail: string,
  lookedFor: readonly string[] = [],
): UnfilledSlot {
  return {
    name: slot.name,
    kind: slot.kind,
    required: slot.required,
    reason,
    detail,
    ...(lookedFor.length > 0 ? { looked_for: lookedFor } : {}),
  };
}

export function resolveIntent(intent: AutomationIntent, evidence: IntentEvidence): ResolvedIntent {
  const filled: FilledSlot[] = [];
  const unresolved: UnfilledSlot[] = [];

  for (const slot of intent.slots) {
    // 1. A value the user supplied always wins: they said it explicitly, and no
    //    amount of looking at a page overrides a person's stated intent.
    const supplied = evidence.supplied?.[slot.name];
    if (supplied !== undefined && supplied !== "") {
      filled.push({
        name: slot.name,
        kind: slot.kind,
        value: supplied,
        source: "supplied_by_user",
      });
      continue;
    }

    // 2. The record locator comes from where the agent already is. It is not a
    //    guess: the origin was authorised by the user's own allowlist.
    if (slot.kind === "record_locator") {
      if (evidence.origin) {
        filled.push({
          name: slot.name,
          kind: slot.kind,
          value: evidence.origin,
          source: "from_origin",
        });
      } else {
        unresolved.push(
          unfilled(slot, "needs_you_to_supply_it", "I don't know which site this happens on."),
        );
      }
      continue;
    }

    // 3. Slots that cannot be discovered must be supplied. Saying so is the
    //    honest answer; there is nothing on a page that reveals what value a
    //    person intends to type.
    if (slot.resolution === "supplied") {
      unresolved.push(
        unfilled(
          slot,
          "needs_you_to_supply_it",
          `${slot.description} — I can't find this by looking; you'll need to tell me.`,
        ),
      );
      continue;
    }

    // 4. Discovery, against the live surface.
    const vocabulary = vocabularyFor(slot, evidence.observed_semantics ?? []);
    const looksLike = vocabulary.length > 0 ? ` (something like ${vocabulary.join(" or ")})` : "";

    if (!evidence.surface?.looked) {
      // NOT the same as "there is nothing there". The agent has not looked yet,
      // and reporting a missing field would be a claim it has not earned.
      unresolved.push(
        unfilled(
          slot,
          "not_looked_yet",
          `I haven't opened the page yet to find ${slot.name}${looksLike}.`,
          vocabulary,
        ),
      );
      continue;
    }

    const matches = matchControls(slot, evidence.surface.controls, vocabulary);
    if (matches.length === 0) {
      unresolved.push(
        unfilled(
          slot,
          "no_matching_control",
          `I looked, but found nothing on the page matching ${slot.description.toLowerCase()}${looksLike}.`,
          vocabulary,
        ),
      );
      continue;
    }
    if (matches.length > 1) {
      unresolved.push(
        unfilled(
          slot,
          "ambiguous_controls",
          `I found ${matches.length} controls that could be ${slot.name} (${matches
            .map((m) => `“${m.name}”`)
            .join(", ")}). Choosing between them is how a helper types into the wrong box.`,
          vocabulary,
        ),
      );
      continue;
    }

    const only = matches[0]!;
    filled.push({
      name: slot.name,
      kind: slot.kind,
      value: only.name,
      // Spread rather than assigning undefined: exactOptionalPropertyTypes
      // distinguishes "absent" from "present and undefined", and a role we did
      // not observe must be absent.
      ...(only.role ? { role: only.role as NonNullable<FilledSlot["role"]> } : {}),
      source: "discovered_on_surface",
    });
  }

  return {
    intent,
    filled,
    unfilled: unresolved,
    // Derived every time rather than stored: a cached "executable" could
    // outlive the evidence that justified it.
    executable: unresolved.filter((u) => u.required).length === 0,
  };
}

/** The slots a user must answer before this can run. */
export function outstandingQuestions(resolved: ResolvedIntent): UnfilledSlot[] {
  return resolved.unfilled.filter((u) => u.required && u.reason === "needs_you_to_supply_it");
}

/** True when looking at the surface could still change the answer. */
export function wouldBenefitFromLooking(resolved: ResolvedIntent): boolean {
  return resolved.unfilled.some((u) => u.reason === "not_looked_yet");
}
