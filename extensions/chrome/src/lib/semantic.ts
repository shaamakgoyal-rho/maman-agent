/**
 * Pure semantic-extraction logic for content scripts. Testable without a DOM:
 * everything operates on plain descriptors extracted at the call site.
 *
 * NEVER reads: password fields, contenteditable regions, email bodies,
 * freeform message fields, or any field value at all — only shapes.
 */

export type FieldDescriptor = {
  tag: string;
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  ariaLabel?: string;
  contentEditable?: boolean;
  role?: string;
};

/** autocomplete values that must never produce any event (spec §10). */
const DENIED_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code"];
const DENIED_AUTOCOMPLETE_PREFIXES = ["cc-"];

const SENSITIVE_NAME_MARKERS = [
  "password",
  "passwd",
  "secret",
  "api-key",
  "api_key",
  "apikey",
  "token",
  "otp",
  "ssn",
  "social-security",
  "bank",
  "routing",
  "card",
  "cvv",
  "cvc",
];

/** Fields whose CONTENT is freeform prose — observe interaction shape only, never text. */
const FREEFORM_MARKERS = ["message", "body", "compose", "comment", "description", "notes"];

export type FieldDecision = "deny" | "shape_only" | "observe";

export function classifyField(field: FieldDescriptor): FieldDecision {
  const type = field.type?.toLowerCase() ?? "";
  if (type === "password" || type === "hidden") return "deny";

  const autocomplete = field.autocomplete?.toLowerCase() ?? "";
  if (DENIED_AUTOCOMPLETE.includes(autocomplete)) return "deny";
  if (DENIED_AUTOCOMPLETE_PREFIXES.some((p) => autocomplete.startsWith(p))) return "deny";

  const hay = `${field.name ?? ""} ${field.id ?? ""} ${field.ariaLabel ?? ""}`.toLowerCase();
  if (SENSITIVE_NAME_MARKERS.some((m) => hay.includes(m))) return "deny";

  if (field.contentEditable) return "shape_only";
  if (field.tag.toLowerCase() === "textarea") return "shape_only";
  if (FREEFORM_MARKERS.some((m) => hay.includes(m))) return "shape_only";

  return "observe";
}

/** SHA-256 (hex, 16 bytes) for stable ids / allowlisted labels. */
export async function stableHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export type UrlContext = { object_type?: string; page_type?: string };

/**
 * Deterministic context derived from a URL — hostname plus path segment NAMES
 * only. Never reads query strings, fragments, record ids, or slugs: a segment
 * is used only when it is structurally guaranteed to be a type name, so ids
 * and PII-bearing slugs can never leak into context.
 */
export function contextFromUrl(url: string): UrlContext {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

  // Salesforce Lightning: /lightning/o/{Object}/... (object home) and
  // /lightning/r/{Object}/{id}/... (record). The Object segment must look like
  // an API object name (starts with a letter) — Salesforce record ids start
  // with a digit key prefix, so bare-id routes like /lightning/r/{id}/view are
  // rejected here and never fall through to the generic rule.
  if (segments[0] === "lightning") {
    const mode = segments[1];
    const object = segments[2];
    if (
      (mode === "o" || mode === "r") &&
      object !== undefined &&
      /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(object)
    ) {
      return {
        object_type: object.toLowerCase(),
        page_type: mode === "o" ? "object_home" : "record",
      };
    }
    return {};
  }

  // Google Sheets.
  if (parsed.hostname === "docs.google.com" && segments[0] === "spreadsheets") {
    return { page_type: "spreadsheet" };
  }

  // Generic fallback: the first path segment, only when purely alphabetic
  // (3-32 chars) — lowercased, with one trailing "s" stripped (naive singular).
  const first = segments[0];
  if (first !== undefined && /^[a-zA-Z]{3,32}$/.test(first)) {
    const lowered = first.toLowerCase();
    return { object_type: lowered.endsWith("s") ? lowered.slice(0, -1) : lowered };
  }
  return {};
}

export type InteractionDescriptor = {
  kind: "click" | "commit" | "navigation" | "copy" | "paste";
  field?: FieldDescriptor;
  targetRole?: string;
  pageUrl: string;
};

export type SemanticEventShape = {
  event_type: string;
  target: { role?: string; semantic_type?: string; stable_id_hash?: string };
  context: { page_type?: string; object_type?: string };
  domain: string;
  /**
   * Stamped by the content script from its TraceSession — the id of the local
   * action trace being recorded as this event happened, and which step of it
   * this interaction became. Opaque local UUID + a counter; never content.
   * Absent when no trace step was recorded (protected observation, incognito).
   */
  trace_ref?: string;
  trace_step_order?: number;
};

/**
 * Builds the semantic event shape for an interaction, or null when nothing may
 * be emitted. Values are never read; the DOM never serialized.
 */
export async function buildSemanticEvent(
  interaction: InteractionDescriptor,
): Promise<SemanticEventShape | null> {
  const url = new URL(interaction.pageUrl);
  const domain = url.hostname;
  // URL-derived, id-free context (object_type / page_type) — same for every
  // event kind on the page. Purely structural; never query/fragment/id data.
  const context = contextFromUrl(interaction.pageUrl);

  if (interaction.field) {
    const decision = classifyField(interaction.field);
    if (decision === "deny") return null;
    if (interaction.kind === "commit") {
      return {
        event_type: "value_committed",
        target: {
          role: interaction.field.tag.toLowerCase(),
          ...(decision === "observe" && interaction.field.name
            ? { semantic_type: interaction.field.name.toLowerCase().slice(0, 64) }
            : {}),
          stable_id_hash: await stableHash(
            `${domain}:${interaction.field.id ?? interaction.field.name ?? "anon"}`,
          ),
        },
        context,
        domain,
      };
    }
  }

  switch (interaction.kind) {
    case "navigation":
      return { event_type: "navigation", target: {}, context, domain };
    case "click":
      return {
        event_type: "element_activated",
        target: {
          ...(interaction.targetRole ? { role: interaction.targetRole } : {}),
          stable_id_hash: await stableHash(`${domain}:${interaction.targetRole ?? "el"}`),
        },
        context,
        domain,
      };
    case "copy":
      return { event_type: "copy_semantic", target: {}, context, domain };
    case "paste":
      return { event_type: "paste_semantic", target: {}, context, domain };
    default:
      return null;
  }
}
