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
        context: {},
        domain,
      };
    }
  }

  switch (interaction.kind) {
    case "navigation":
      return { event_type: "navigation", target: {}, context: {}, domain };
    case "click":
      return {
        event_type: "element_activated",
        target: {
          ...(interaction.targetRole ? { role: interaction.targetRole } : {}),
          stable_id_hash: await stableHash(`${domain}:${interaction.targetRole ?? "el"}`),
        },
        context: {},
        domain,
      };
    case "copy":
      return { event_type: "copy_semantic", target: {}, context: {}, domain };
    case "paste":
      return { event_type: "paste_semantic", target: {}, context: {}, domain };
    default:
      return null;
  }
}
