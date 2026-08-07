import { capabilitiesForToken, NON_VALUE_HOLDING_ROLES } from "@maman/capability-catalog";
import type { PatternCandidate } from "@maman/contracts";
import { bareRoleNoun, roleNoun } from "./explain.js";
import type { SegmentedEpisode } from "./segmentation.js";

/**
 * Deterministic recommendation naming. Always available — the flow never
 * depends on a model. A ModelProvider may later rewrite title/summary copy
 * only; it can never change eligibility, risk, permissions, or value.
 */

const APP_LABELS: Record<string, string> = {
  crm: "Salesforce",
  spreadsheet: "your spreadsheet",
  email: "Gmail",
  calendar: "Calendar",
  research: "research tools",
  browser: "the browser",
  other: "your apps",
};

const ACTION_LABELS: Record<string, string> = {
  navigation: "Open",
  table_read: "Read a table in",
  value_committed: "Edit fields in",
  record_opened: "Look up records in",
  record_updated: "Update records in",
  copy_semantic: "Copy data from",
  paste_semantic: "Paste data into",
  table_exported: "Export a report from",
  element_activated: "Search in",
  element_focused: "Work in",
  app_activated: "Switch to",
  window_focused: "Focus",
};

export type NamingResult = {
  title: string;
  summary: string;
  generalized_intent: string;
  redacted_steps: Array<{ order: number; app: string; action: string }>;
  required_capabilities: string[];
};

export function deterministicName(
  candidate: PatternCandidate,
  members: SegmentedEpisode[],
): NamingResult {
  const categories = new Set(members.flatMap((m) => m.app_categories));
  const objectType = mostCommonObject(candidate.canonical_sequence) ?? "record";
  const outcome = candidate.canonical_sequence.at(-1)?.split(":")[2] ?? "";

  // Named recipes for well-understood shapes; generic fallback otherwise.
  let title: string;
  let intent: string;
  if (categories.has("crm") && categories.has("spreadsheet") && objectType === "account") {
    title = "Reconcile account lists with Salesforce";
    intent = "reconcile_account_list";
  } else if (
    categories.has("crm") &&
    (outcome === "record_updated" || outcome === "value_committed")
  ) {
    // Live observation ends CRM edits with value_committed (field commits);
    // curated fixtures end with record_updated. Same business action.
    title = `Update ${objectType} records in Salesforce`;
    intent = `update_${objectType}_records`;
  } else if (categories.has("spreadsheet") && outcome === "table_exported") {
    title = `Export the ${objectType} report from your spreadsheet`;
    intent = `generate_${objectType}_report`;
  } else {
    // Describe what was actually OBSERVED rather than labelling it "automate
    // your <thing> workflow", which says nothing and implies an object we may
    // never have seen (objectType silently falls back to "record").
    title = describeObserved(candidate.canonical_sequence, candidate.domain_actions ?? []);
    intent = `automate_${objectType}_workflow`;
  }

  const medianMinutes = Math.round(candidate.median_duration_ms / 60_000);
  const dayWord = candidate.distinct_day_count === 1 ? "day" : "days";
  // Lead with the STEPS. "I noticed a similar workflow N times" describes the
  // detector, not the work — the reader cannot tell which of their habits this
  // is without being told what it consists of.
  const steps = stepPhrase(candidate.canonical_sequence);
  const summary =
    (steps ? `You ${steps}. ` : "") +
    `I saw this ${candidate.occurrence_count} times across ${candidate.distinct_day_count} ` +
    `${dayWord}; the median run took ${medianMinutes} minutes. ` +
    `I can draft a helper and show you exactly what it would do before anything changes.`;

  // Redacted evidence steps (≤5 by default; the UI can expand).
  const seen = new Set<string>();
  const redacted_steps: NamingResult["redacted_steps"] = [];
  for (const token of candidate.canonical_sequence) {
    const [, app = "other", eventType = ""] = token.split(":");
    const key = `${app}:${eventType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    redacted_steps.push({
      order: redacted_steps.length + 1,
      app: APP_LABELS[app] ?? app,
      action: ACTION_LABELS[eventType] ?? eventType,
    });
  }

  const required = new Set<string>();
  for (const token of candidate.canonical_sequence) {
    for (const capability of capabilitiesForToken(token)) required.add(capability);
  }

  return {
    title,
    summary,
    generalized_intent: intent,
    redacted_steps,
    required_capabilities: [...required].sort(),
  };
}

function mostCommonObject(sequence: string[]): string | null {
  const counts = new Map<string, number>();
  for (const token of sequence) {
    const object = token.split(":")[5];
    if (object && object !== "-") counts.set(object, (counts.get(object) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [object, count] of counts) {
    if (count > bestCount) {
      best = object;
      bestCount = count;
    }
  }
  return best;
}

/* ------------------------------------------------------- observed description */

type ParsedStep = {
  app: string;
  event: string;
  role: string;
  semantic: string;
  object: string;
};

/**
 * Whether a step only READS, role-aware: a `value_committed` on a role that
 * cannot hold user input is the page updating itself, not the user writing —
 * the SAME set the capability mapping and risk scoring key on, so the title's
 * verb can never contradict what the helper would be allowed to do. Unknown
 * roles stay write-like, matching the catalog's conservative choice.
 */
function isReadLike(step: ParsedStep): boolean {
  if (READ_EVENTS.has(step.event)) return true;
  // Browser only — the exact scope of the catalog's role exception. A relay
  // app (crm/spreadsheet/erp) reporting value_committed on a container role
  // still keeps its write mapping there, so naming must agree.
  return (
    step.app === "browser" &&
    step.event === "value_committed" &&
    NON_VALUE_HOLDING_ROLES.has(step.role)
  );
}

/** Events that only READ. A workflow of these is a review, not a change. */
const READ_EVENTS = new Set([
  "navigation",
  "record_opened",
  "table_read",
  "element_focused",
  "window_focused",
  "app_activated",
  "element_activated",
  "copy_semantic",
]);

/** Transitive verbs, so a real object can follow them in a title. */
/**
 * Prose for a step whose object we never saw. Each phrase states exactly what the
 * event type means and nothing more — the implicit noun ("a table", "fields")
 * comes from the event's own definition, not from a guess about the user's data.
 */
const STEP_PHRASES: Record<string, string> = {
  navigation: "open a page",
  record_opened: "open a record",
  table_read: "read a table",
  table_exported: "export a report",
  value_committed: "edit fields",
  record_updated: "update a record",
  copy_semantic: "copy data",
  paste_semantic: "paste data",
  element_activated: "run a search",
  element_focused: "work in a field",
  window_focused: "switch windows",
  app_activated: "switch apps",
};

/** Transitive verbs, so a real object can follow them in a title. */
const TITLE_VERBS: Record<string, string> = {
  navigation: "Open",
  record_opened: "Open",
  table_read: "Read",
  table_exported: "Export",
  value_committed: "Update",
  record_updated: "Update",
  copy_semantic: "Copy",
  paste_semantic: "Paste",
  element_activated: "Search",
  element_focused: "Review",
  window_focused: "Review",
  app_activated: "Switch to",
};

function parseStep(token: string): ParsedStep {
  const parts = token.split(":");
  return {
    app: parts[1] ?? "other",
    event: parts[2] ?? "",
    role: parts[3] ?? "-",
    semantic: parts[4] ?? "-",
    object: parts[5] ?? "-",
  };
}

/** "purchase_order" → "purchase orders". Plural because a pattern recurs. */
function humanizePlural(raw: string): string {
  const words = raw.replace(/_/g, " ").trim();
  if (!words) return words;
  if (/(s|x|z|ch|sh)$/.test(words)) return `${words}es`;
  if (/[^aeiou]y$/.test(words)) return `${words.slice(0, -1)}ies`;
  return `${words}s`;
}

/** Pluralizes a role phrase's HEAD noun: "section of the page" → "sections of
 * the page", never "section of the pages". */
function pluralizeRolePhrase(noun: string): string {
  const ofIndex = noun.indexOf(" of ");
  if (ofIndex !== -1) return humanizePlural(noun.slice(0, ofIndex)) + noun.slice(ofIndex);
  return humanizePlural(noun);
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v || v === "-") continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  // Ascending key order breaks ties deterministically.
  for (const key of [...counts.keys()].sort()) {
    const n = counts.get(key)!;
    if (n > bestCount) {
      best = key;
      bestCount = n;
    }
  }
  return best;
}

/**
 * A title describing the workflow that was actually observed.
 *
 * Built strictly from evidence, in descending order of specificity: a pack
 * ACTION if the classifier recognised one, then the semantic type of the fields
 * touched, then the object type. When none of that exists the title says so —
 * "Repeated 4-step workflow in the browser" — because an honest vague title beats
 * a confident meaningless one. Nothing here invents an app or an object.
 */
export function describeObserved(sequence: string[], domainActions: string[]): string {
  const steps = sequence.map(parseStep);
  if (steps.length === 0) return "Repeated workflow";

  const appLabel = (app: string): string => APP_LABELS[app] ?? app;
  // Role-aware: a value change the user could not have typed does not make a
  // step the workflow's "write" — otherwise a page updating itself becomes
  // the title's headline act.
  const lastWrite = [...steps].reverse().find((s) => !isReadLike(s));
  const firstRead = steps.find((s) => isReadLike(s));
  const head = lastWrite ?? steps[0]!;
  const apps = [...new Set(steps.map((s) => s.app))];
  const readOnlyAcrossApps = !lastWrite && apps.length > 1;

  // Subject selection avoids MISATTRIBUTION: taking the noun from one step and
  // the app from another produced titles like "Open events in Gmail" for a
  // workflow whose events lived in Calendar. For a read-only flow spanning apps
  // the shared object type is the honest common noun; otherwise the noun must
  // come from the step the title names.
  const subjectRaw = readOnlyAcrossApps
    ? (mostCommon(steps.map((s) => s.object)) ?? mostCommon(steps.map((s) => s.semantic)))
    : (nonEmpty(head.semantic) ??
      nonEmpty(head.object) ??
      mostCommon(steps.map((s) => s.semantic)) ??
      mostCommon(steps.map((s) => s.object)));
  const subject = subjectRaw ? humanizePlural(subjectRaw) : null;

  const target = appLabel(head.app);
  const source = firstRead && firstRead.app !== head.app ? appLabel(firstRead.app) : null;

  if (!subject) {
    // No semantic or object noun anywhere — but the target ROLE is still real
    // observed evidence, and "Update text fields in the browser" tells the
    // reader which habit this is where "Repeated 3-step workflow" told them
    // nothing. The AX role is the most specific thing the observer records
    // about a step it cannot name.
    const headRoleNoun = bareRoleNoun(head.role);
    if (headRoleNoun) {
      const verb = TITLE_VERBS[head.event] ?? "Work through";
      const where = source ? `${target} from ${source}` : target;
      return `${verb} ${pluralizeRolePhrase(headRoleNoun)} in ${where}`;
    }
    // Not even a role: name the shape instead of pretending to know the noun.
    const where = source ? `${source} and ${target}` : target;
    return `Repeated ${steps.length}-step workflow in ${where}`;
  }

  // A pack action is the most specific verb available — the classifier named the
  // business action, not just the UI event ("post journals", not "update fields").
  const packVerb = domainActions.length > 0 ? domainActions[domainActions.length - 1] : undefined;
  if (packVerb) {
    const words = packVerb.split("_");
    const action = capitalize(
      [...words.slice(0, -1), humanizePlural(words[words.length - 1] ?? "")].join(" "),
    );
    // "Approve invoices for invoices" is nonsense: drop the subject when the
    // action already names it.
    const redundant = words.some((w) => subjectRaw?.includes(w));
    const withSubject = redundant ? action : `${action} for ${subject}`;
    return source ? `${withSubject} in ${target} from ${source}` : `${withSubject} in ${target}`;
  }

  const verb = TITLE_VERBS[head.event] ?? "Work through";
  if (readOnlyAcrossApps) {
    return `${verb} ${subject} in ${apps.slice(0, 2).map(appLabel).join(" and ")}`;
  }
  if (source) return `${verb} ${subject} in ${target} from ${source}`;
  return `${verb} ${subject} in ${target}`;
}

/** A canonical-token field that carries real information ("-" means absent). */
function nonEmpty(value: string): string | null {
  return value && value !== "-" ? value : null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The observed steps as prose: "open records in Salesforce, read a table, then
 * edit fields". Built from the same canonical tokens the card's evidence list
 * shows, so the summary and the evidence can never disagree.
 *
 * The app is named only when it CHANGES between steps — repeating "in Salesforce"
 * four times reads like filler and buries the one app switch that matters.
 */
export function stepPhrase(sequence: string[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  let lastApp: string | null = null;
  for (const token of sequence) {
    const step = parseStep(token);
    // Role in the key: "a block of text updates" and "change a text field"
    // are different steps even though both are browser value_committed.
    const key = `${step.app}:${step.event}:${step.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // With a real noun, name it. Without one, fall back to the ROLE — "focus a
    // section of the page" says which habit this is where "work in a field"
    // said nothing — and only then to the event's own generic phrase.
    const noun = nonEmpty(step.semantic) ?? nonEmpty(step.object);
    const stepRoleNoun = roleNoun(step.role);
    let verb: string;
    if (noun) {
      verb = `${(TITLE_VERBS[step.event] ?? step.event.replace(/_/g, " ")).toLowerCase()} ${humanizePlural(noun)}`;
    } else if (stepRoleNoun && step.event === "element_focused") {
      verb = `focus ${stepRoleNoun}`;
    } else if (stepRoleNoun && step.event === "value_committed") {
      // Same agency distinction as the capability mapping: the page updating
      // itself must not read as the user typing.
      verb = NON_VALUE_HOLDING_ROLES.has(step.role)
        ? `${stepRoleNoun} updates`
        : `change ${stepRoleNoun}`;
    } else {
      verb = STEP_PHRASES[step.event] ?? step.event.replace(/_/g, " ");
    }
    const nounText = "";
    const appText = step.app !== lastApp ? ` in ${APP_LABELS[step.app] ?? step.app}` : "";
    lastApp = step.app;
    parts.push(`${verb}${nounText}${appText}`);
    if (parts.length === 4) break;
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")}, then ${parts[parts.length - 1]}`;
}
