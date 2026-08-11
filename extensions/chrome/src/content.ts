/**
 * Content script for allowlisted, user-enabled origins only (registered
 * dynamically per domain after an explicit optional-permission grant).
 *
 * Emits semantic SHAPES: element roles, hashed ids, event kinds. It never
 * reads field values, password fields, contenteditable regions, email bodies,
 * or freeform message fields, and never serializes the DOM.
 */
import { buildSemanticEvent, type FieldDescriptor } from "./lib/semantic.js";
import { executeBrowserAction, type ActuationContext } from "./lib/actuate.js";
import { accessibleName, roleOf } from "./lib/dom-adapter.js";
import { TraceSession, type TraceObservation } from "./lib/trace.js";

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

/**
 * THE REPLAYABLE LAYER, buffered here and flushed on a boundary.
 *
 * Private browsing is refused up front rather than per field: in an incognito
 * context every observation becomes a hole, so `flush` yields nothing and no
 * trace ever leaves the page.
 */
const incognito = chrome.extension?.inIncognitoContext === true;
const session = new TraceSession(() => crypto.randomUUID());
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Records one interaction for the trace. Never reads a value. */
function observe(kind: TraceObservation["kind"], el?: Element) {
  const observation: TraceObservation = {
    at: new Date().toISOString(),
    kind,
    pageUrl: location.href,
    ...(incognito ? { refused: "private_browsing" as const } : {}),
    ...(el && isFieldLike(el) ? { field: describeField(el) } : {}),
    ...(el ? { role: roleOf(el) ?? el.tagName.toLowerCase() } : {}),
    // A LABEL, not the data inside the control: `accessibleName` reads
    // aria-label / <label> / button text, never `value`.
    ...(el && accessibleName(el) ? { accessibleName: accessibleName(el).slice(0, 120) } : {}),
    ...(el?.id ? { identifier: el.id } : {}),
  };
  if (session.push(observation)) void flushTrace();
  else scheduleFlush();
}

/**
 * A routine is finished when the user stops for a while. Idle is the boundary
 * rather than a fixed window, because a workflow's length is the user's, not
 * ours.
 */
const IDLE_FLUSH_MS = 20_000;
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushTrace(), IDLE_FLUSH_MS);
}

async function flushTrace() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  const trace = session.flush([{ category: "browser", origin: location.origin }]);
  if (!trace) return; // nothing survived capture — say nothing
  try {
    await chrome.runtime.sendMessage({ type: "action_trace", trace });
  } catch {
    // Service worker asleep and the message lost. The trace is dropped rather
    // than retried: a routine Maman half-remembers is worse than one it missed,
    // and the next repetition produces another.
  }
}

async function send(kind: "click" | "commit" | "navigation" | "copy" | "paste", el?: Element) {
  observe(kind, el);
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

/**
 * Supervised actuation. Page scripts cannot reach this listener at all — only
 * other parts of this extension can send runtime messages, and the sender check
 * below rejects anything else. That, rather than the request's token, is what
 * makes it impossible for page content to trigger an action; the token stops a
 * replay of one the desktop already spent.
 */
chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; request?: unknown; context?: ActuationContext },
    sender,
    sendResponse,
  ) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.type !== "browser_action_request" || !message.context) return false;
    sendResponse(executeBrowserAction(message.request, message.context, document, new Date()));
    return false; // answered synchronously
  },
);

// The page is going away: flush what the session has rather than losing a
// routine to a navigation. `pagehide` fires where `unload` is unreliable.
window.addEventListener("pagehide", () => void flushTrace(), { capture: true });
