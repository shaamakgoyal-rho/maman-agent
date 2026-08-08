import type { ResolvedIntent, UnfilledSlot } from "./types.js";

/**
 * Says what the agent will ACTUALLY do, in terms of the real surface.
 *
 * The description this replaces was `Helper: ${intent.replaceAll("_", " ")}` —
 * "Helper: update account records". Every agent built from the same intent got
 * the same sentence, so it distinguished nothing, named nothing the user could
 * check, and would have read identically whether the helper was about to touch
 * the right field or the wrong one.
 *
 * A description here is assembled from RESOLVED SLOTS, so every noun in it is
 * something that was found or supplied: a real origin, a real control name, a
 * real value. That has a useful consequence — an incomplete intent cannot
 * produce a confident sentence, because the words simply are not available. The
 * copy degrades into naming what is missing, which is exactly what the user
 * needs to see at that moment.
 */

/**
 * "acme.example" from "https://acme.example" — the part a person recognises.
 *
 * Parsed by hand rather than with `URL` because this package compiles without
 * the DOM lib: being unable to reach a browser global is what keeps the layer
 * pure and testable in isolation.
 */
function siteName(origin: string): string {
  const withoutScheme = origin.replace(/^https?:\/\//, "");
  const host = withoutScheme.split("/")[0] ?? withoutScheme;
  return host.length > 0 ? host : origin;
}

function quoted(value: string): string {
  return `“${value}”`;
}

/**
 * How to refer to a slot in a sentence, filled or not.
 *
 * An unfilled DISCOVERABLE slot still has something true to say: the agent
 * knows what it will go and look for, even before it has looked. "the phone
 * field" is not a claim that a phone field exists — it is a statement of what
 * the agent will search the page for, and the user is the person best placed to
 * notice that it is searching for the wrong thing. That is only possible
 * because vocabulary survives resolution on `looked_for`.
 */
function phraseFor(
  resolved: ResolvedIntent,
  kind: "record_locator" | "field" | "value" | "commit_control",
  fallback: (lookedFor: readonly string[]) => string,
): string | undefined {
  const slot = resolved.intent.slots.find((s) => s.kind === kind);
  if (!slot) return undefined;
  const found = resolved.filled.find((f) => f.kind === kind);
  if (found) {
    return kind === "record_locator" ? siteName(found.value) : quoted(found.value);
  }
  const gap = resolved.unfilled.find((u) => u.kind === kind);
  return fallback(gap?.looked_for ?? []);
}

/**
 * One sentence naming the concrete work. Falls back to naming the gap when the
 * intent is not executable — never to a generic claim.
 */
export function describeResolvedIntent(resolved: ResolvedIntent): string {
  return resolved.executable ? describeIntentPlan(resolved) : describeGap(resolved);
}

/**
 * What the agent intends to do, stated concretely BEFORE it has looked at
 * anything — which is when the user reads the card and decides.
 *
 * `describeResolvedIntent` deliberately refuses to make a confident claim about
 * an intent that cannot run; this says what the run WOULD be. The two are the
 * same sentence once everything is resolved, so there is one set of phrasing
 * rules, not two that can drift apart. The difference is only in what an
 * unfilled slot contributes: a promise to go and find something, rather than a
 * name that was found.
 */
export function describeIntentPlan(resolved: ResolvedIntent): string {
  const { intent } = resolved;
  const where = phraseFor(resolved, "record_locator", () => "the record you have open");
  const what = phraseFor(resolved, "field", (lookedFor) =>
    lookedFor.length > 0 ? `the ${lookedFor.join("/")} field` : "the field you point me at",
  );
  const to = phraseFor(resolved, "value", () => "a value you give me");
  const commit = phraseFor(resolved, "commit_control", () => "");

  const then =
    intent.success === "readback"
      ? ", then read it back to confirm it took"
      : intent.success === "independent_read"
        ? ", then check the record again independently"
        : "";

  return [
    intent.verb,
    what ? ` ${what}` : "",
    where ? ` on ${where}` : "",
    // A supplied value is quoted verbatim so the user can see exactly what
    // would be written; an unsupplied one is described, never invented.
    to ? ` to ${to}` : "",
    commit ? `, press ${commit}` : "",
    then,
    ".",
  ].join("");
}

/**
 * What is missing, in the order a person would want to fix it: things only they
 * can answer first, then things the agent still has to go and look at.
 */
export function describeGap(resolved: ResolvedIntent): string {
  const required = resolved.unfilled.filter((u) => u.required);
  if (required.length === 0) return resolved.intent.purpose;

  const rank = (u: UnfilledSlot) => (u.reason === "needs_you_to_supply_it" ? 0 : 1);
  const first = [...required].sort((a, b) => rank(a) - rank(b))[0]!;
  const rest = required.length - 1;
  return rest > 0
    ? `${first.detail} (and ${rest} more thing${rest === 1 ? "" : "s"} to settle)`
    : first.detail;
}

/**
 * The per-step plan the user approves, in the same concrete terms.
 *
 * Each line names a real control, so a reader can hold it against the page in
 * front of them. A plan that cannot name its controls has nothing to check, and
 * approving it would be approving a shape rather than an action.
 */
export function describeResolvedSteps(resolved: ResolvedIntent): string[] {
  return resolved.executable ? describeIntentPlanSteps(resolved) : [];
}

/**
 * The same plan, stated before the agent has looked at anything.
 *
 * Every line still names either a real control or the specific thing the agent
 * will go and find, so the user can check the plan against the page in front of
 * them either way. The line that writes is always exactly one line, and always
 * says so.
 */
export function describeIntentPlanSteps(resolved: ResolvedIntent): string[] {
  const { intent } = resolved;
  const writes = intent.slots.some((s) => s.kind === "value");

  const where = phraseFor(resolved, "record_locator", () => "the record you have open");
  const what = phraseFor(resolved, "field", (lookedFor) =>
    lookedFor.length > 0 ? `the ${lookedFor.join("/")} field` : "the field you point me at",
  );
  const to = phraseFor(resolved, "value", () => "the value you give me");
  const commit = phraseFor(resolved, "commit_control", () => "");

  const lines: string[] = [];
  // "Open acme.example" when the site is known; when it is not, the agent is
  // not opening anything — it is working on the record already in front of the
  // user, and saying "open the record you have open" would be nonsense.
  const openLine = resolved.filled.some((f) => f.kind === "record_locator")
    ? `Open ${where} and wait for the page.`
    : "Work on the record you already have open.";
  if (where) lines.push(openLine);
  if (what) lines.push(`Read ${what} so I can show you what would change.`);
  if (what && to && writes) {
    lines.push(`Propose setting ${what} to ${to} — nothing is written yet.`);
    lines.push(`After you approve, set ${what}. This is the only write.`);
  }
  if (commit) lines.push(`Press ${commit} to commit.`);
  if (intent.success === "readback" && what) {
    lines.push(`Read ${what} again, independently, and compare.`);
  }
  return lines;
}

/**
 * A short title for the agent, in the same grounded vocabulary.
 *
 * The deterministic fallback used to be `Helper: ${intent}` — "Helper: automate
 * record workflow" — which named the compiler's own label rather than the work,
 * and read identically for every agent derived from it. This names the field
 * where one is known and says plainly when it is not, so two agents over
 * different fields never carry the same title.
 */
export function describeIntentTitle(resolved: ResolvedIntent): string {
  const writes = resolved.intent.slots.some((s) => s.kind === "value");
  const what = phraseFor(resolved, "field", (lookedFor) =>
    lookedFor.length > 0 ? `the ${lookedFor.join("/")} field` : "a field",
  );
  const verb = writes ? "Update" : "Read";
  const site = resolved.filled.find((f) => f.kind === "record_locator");
  const where = site ? ` on ${siteName(site.value)}` : " on this record";
  return `${verb} ${what ?? "this record"}${where}`;
}

/**
 * Where each answer came from — so a reader can tell what the agent found for
 * itself from what they told it. A helper that discovered a field and one that
 * was handed it deserve different amounts of trust.
 */
export function describeProvenance(resolved: ResolvedIntent): string[] {
  return resolved.filled.map((f) => {
    switch (f.source) {
      case "discovered_on_surface":
        return `${f.name}: I found ${quoted(f.value)} on the page.`;
      case "supplied_by_user":
        return `${f.name}: you told me this.`;
      case "from_origin":
        return `${f.name}: ${siteName(f.value)}, from the sites you allowed.`;
    }
  });
}
