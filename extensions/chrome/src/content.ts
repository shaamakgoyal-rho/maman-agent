/**
 * Content script for allowlisted, user-enabled origins only (registered
 * dynamically per domain after an explicit optional-permission grant).
 *
 * Emits semantic SHAPES: element roles, hashed ids, event kinds. It never
 * reads field values, password fields, contenteditable regions, email bodies,
 * or freeform message fields, and never serializes the DOM.
 */
import { buildSemanticEvent, type FieldDescriptor } from "./lib/semantic.js";

function describeField(el: Element): FieldDescriptor {
  const input = el as HTMLInputElement;
  return {
    tag: el.tagName,
    ...(input.type ? { type: input.type } : {}),
    ...(input.autocomplete ? { autocomplete: input.autocomplete } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(el.id ? { id: el.id } : {}),
    ...(el.getAttribute("aria-label") ? { ariaLabel: el.getAttribute("aria-label")! } : {}),
    contentEditable: (el as HTMLElement).isContentEditable,
    ...(el.getAttribute("role") ? { role: el.getAttribute("role")! } : {}),
  };
}

async function send(kind: "click" | "commit" | "navigation" | "copy" | "paste", el?: Element) {
  const shape = await buildSemanticEvent({
    kind,
    ...(el && (kind === "commit" || kind === "click") && isFieldLike(el)
      ? { field: describeField(el) }
      : {}),
    ...(el?.getAttribute("role") ? { targetRole: el.getAttribute("role")! } : {}),
    pageUrl: location.href,
  });
  if (!shape) return; // redacted at the source
  try {
    await chrome.runtime.sendMessage({ type: "semantic_event", event: shape });
  } catch {
    // service worker asleep and message lost — acceptable; shapes are lossy by design
  }
}

function isFieldLike(el: Element): boolean {
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    (el as HTMLElement).isContentEditable
  );
}

// Navigation (SPA-aware via History API events is overkill for v1: emit once per load).
void send("navigation");

// Semantic interactions. NOTE: no key-event listeners exist anywhere in this
// extension — that entire input channel is structurally absent.
document.addEventListener(
  "click",
  (e) => {
    const target = e.target as Element | null;
    if (!target) return;
    const interactive = target.closest("a, button, [role], input, select");
    if (interactive) void send("click", interactive);
  },
  { capture: true, passive: true },
);

document.addEventListener(
  "change",
  (e) => {
    const target = e.target as Element | null;
    if (target && isFieldLike(target)) void send("commit", target);
  },
  { capture: true, passive: true },
);

document.addEventListener("copy", () => void send("copy"), { capture: true, passive: true });
document.addEventListener("paste", () => void send("paste"), { capture: true, passive: true });
