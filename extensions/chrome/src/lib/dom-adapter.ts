/**
 * The only part of the extension that touches live elements.
 *
 * Everything that DECIDES whether to act lives in `@maman/browser-actuator` and
 * runs against the DOM-free `CandidateControl` shapes this file produces. Keeping
 * the adapter this thin is the point: it is the part that cannot be unit-tested
 * against every real page, so it must contain no policy.
 */
import type { BrowserAction, BrowserTargetRole } from "@maman/contracts";
import type { CandidateControl } from "@maman/browser-actuator";

export interface ControlBinding {
  control: CandidateControl;
  element: Element;
}

/**
 * Attributes that mark a field as secure or otherwise never-touchable.
 *
 * This list is a floor, not the mechanism — `isSecure` defaults to TRUE for
 * anything it cannot positively clear, so a field this list misses is still
 * refused unless it looks like an ordinary labelled input.
 */
const SECURE_AUTOCOMPLETE =
  /password|cc-|card|cvc|cvv|one-time-code|new-password|current-password/i;
const SECURE_NAME_HINT = /pass(word|wd)?|pwd|secret|token|otp|mfa|cvv|cvc|ssn|sin\b|routing|iban/i;

/** Roles the actuator can address, mapped from tag + type + explicit ARIA role. */
export function roleOf(el: Element): BrowserTargetRole | undefined {
  const aria = el.getAttribute("role")?.toLowerCase();
  switch (aria) {
    case "textbox":
    case "combobox":
    case "checkbox":
    case "button":
    case "link":
    case "heading":
      return aria;
    case "cell":
    case "gridcell":
      return "cell";
    default:
      break;
  }

  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "button") return "button";
  if (tag === "a") return el.hasAttribute("href") ? "link" : undefined;
  if (tag === "td" || tag === "th") return "cell";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "submit" || type === "button" || type === "reset") return "button";
    // Radio is deliberately absent: a radio group is addressed by its options, and
    // "the radio named X" does not identify a choice unambiguously.
    if (type === "radio" || type === "file" || type === "hidden" || type === "image") {
      return undefined;
    }
    return "textbox";
  }
  return undefined;
}

/**
 * Is this field secure, private, or otherwise not ours to read or type into?
 *
 * Returns true on doubt. The asymmetry is deliberate: refusing a legitimate field
 * costs the user one message, and the opposite mistake means typing into — or
 * reading out of — a credential box.
 */
export function isSecure(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  // Freeform editable regions are out of scope entirely. The observer already
  // refuses to read them, and a rich-text region has no verifiable read-back, so
  // a write into one could never be confirmed.
  // The attribute is checked alongside the property because not every engine
  // implements `isContentEditable` — relying on the property alone would leave the
  // shipped check stricter than the tested one.
  if (isContentEditableEl(el)) return true;

  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type.toLowerCase() === "password") return true;
    if (SECURE_AUTOCOMPLETE.test(input.autocomplete || "")) return true;
    if (SECURE_NAME_HINT.test(`${input.name} ${input.id}`)) return true;
  }
  if (tag === "textarea" || tag === "select") {
    const named = el as HTMLTextAreaElement | HTMLSelectElement;
    if (SECURE_NAME_HINT.test(`${named.name} ${named.id}`)) return true;
  }

  // A password manager's injected UI is not part of the page's own form.
  if (el.closest("[data-1p-ignore], [data-lastpass-icon-root], [data-bitwarden-watching]")) {
    return true;
  }

  return false;
}

function isContentEditableEl(el: Element): boolean {
  if ((el as HTMLElement).isContentEditable === true) return true;
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr?.toLowerCase() === "true";
}

/** True only for controls a write may modify. */
function isEditable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if ((el as HTMLButtonElement).disabled === true) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (tag === "input" || tag === "textarea") {
    return !(el as HTMLInputElement).readOnly;
  }
  if (el.getAttribute("aria-readonly") === "true") return false;
  return true;
}

/**
 * Hidden by CSS or by ARIA, anywhere up the ancestor chain.
 *
 * The walk is necessary because `getComputedStyle` reports an element's own
 * `display`, not its parent's — a control inside a collapsed panel computes
 * `display: block` and would otherwise look addressable.
 *
 * Layout boxes are deliberately not consulted: an environment without layout
 * reports every element as zero-sized, which would make the shipped check and the
 * tested check different things.
 */
export function isHiddenByStyleOrAria(el: Element): boolean {
  let node: Element | null = el;
  while (node !== null && node.nodeType === 1) {
    if (node.hasAttribute("hidden")) return true;
    if (node.getAttribute("aria-hidden") === "true") return true;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style) {
      if (style.display === "none" || style.visibility === "hidden") return true;
      if (style.opacity === "0") return true;
    }
    node = node.parentElement;
  }
  return false;
}

function isVisible(el: Element): boolean {
  if (isHiddenByStyleOrAria(el)) return false;
  // In Chrome this adds content-visibility and other cases the walk cannot see.
  // Where it does not exist, the walk above is the whole answer.
  const target = el as Element & { checkVisibility?: (o?: object) => boolean };
  if (typeof target.checkVisibility === "function") {
    return target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return true;
}

/**
 * Accessible name — the simplified accname path, in the order fixed by
 * `domain/accessible-name-conformance.json`.
 *
 * That fixture, not this function, is the specification. The other actuation
 * lane (`AGENT_PAGE_SCRIPT` in `@maman/browser-actuator`) computes the same name
 * from ES5 source evaluated inside the page, and the two cannot share code, so
 * both suites assert the same table. The rung order and the reasoning behind the
 * two non-obvious placements — `name` last, `value` above `title` — live next to
 * `ACCESSIBLE_NAME_SOURCE`; change them there and here together, or the fixture
 * fails on one side.
 *
 * A name this code cannot compute yields `no_match`, which asks the user, rather
 * than a wrong element.
 */
export function accessibleName(el: Element): string {
  const attr = (name: string): string => normalizeNameWhitespace(el.getAttribute(name) ?? "");

  const labelledBy = attr("aria-labelledby");
  if (labelledBy) {
    const text = normalizeNameWhitespace(
      labelledBy
        .split(" ")
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (text) return text;
  }

  const ariaLabel = attr("aria-label");
  if (ariaLabel) return ariaLabel;

  if (el.id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${cssEscape(el.id)}"]`);
    const forText = normalizeNameWhitespace(forLabel?.textContent ?? "");
    if (forText) return forText;
  }
  const wrapping = normalizeNameWhitespace(el.closest("label")?.textContent ?? "");
  if (wrapping) return wrapping;

  if (el.tagName.toLowerCase() === "input" && isButtonType(el)) {
    const buttonValue = normalizeNameWhitespace((el as HTMLInputElement).value ?? "");
    if (buttonValue) return buttonValue;
  }

  const placeholder = attr("placeholder");
  if (placeholder) return placeholder;

  const title = attr("title");
  if (title) return title;

  const text = normalizeNameWhitespace(el.textContent ?? "");
  if (text) return text;

  // Last resort, and never above visible text: a machine token is better than
  // an unaddressable control, but worse than anything a human could read.
  return attr("name");
}

/**
 * Collapse runs of whitespace, NBSP included, and trim.
 *
 * `normalizeName` in the resolver would do this anyway for THIS lane, but the
 * other lane compares `confirm_name` by exact equality against a live document.
 * Normalising at the source is what makes one page yield one string in both.
 */
function normalizeNameWhitespace(raw: string): string {
  return raw
    .replace(/\u00a0/g, " ") // escaped: a literal NBSP here is invisible in review
    .replace(/\s+/g, " ")
    .trim();
}

function isButtonType(el: Element): boolean {
  const type = (el as HTMLInputElement).type?.toLowerCase();
  return type === "submit" || type === "button" || type === "reset";
}

function cssEscape(value: string): string {
  const escaper = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  return escaper ? escaper(value) : value.replace(/["\\]/g, "\\$&");
}

/** Current value, or undefined when the control has none that can be read safely. */
export function readValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    return select.selectedOptions[0]?.textContent?.trim() ?? "";
  }
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type.toLowerCase() === "checkbox") return input.checked ? "true" : "false";
    return input.value;
  }
  if (tag === "textarea") return (el as HTMLTextAreaElement).value;
  if (el.getAttribute("role") === "checkbox") {
    return el.getAttribute("aria-checked") === "true" ? "true" : "false";
  }
  // Buttons, links, cells and headings expose their text as their value.
  return el.textContent?.trim() ?? undefined;
}

const ADDRESSABLE = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "td",
  "th",
  "h1,h2,h3,h4,h5,h6",
  "[role]",
].join(",");

/** Every control on the page the actuator could address, in document order. */
export function collectControls(doc: Document): ControlBinding[] {
  const bindings: ControlBinding[] = [];
  for (const el of doc.querySelectorAll(ADDRESSABLE)) {
    const role = roleOf(el);
    if (role === undefined) continue;
    const value = readValue(el);
    bindings.push({
      element: el,
      control: {
        role,
        accessibleName: accessibleName(el),
        ...(value === undefined ? {} : { value }),
        editable: isEditable(el),
        secure: isSecure(el),
        visible: isVisible(el),
      },
    });
  }
  return bindings;
}

/**
 * Perform the action on a resolved element and report what the page holds
 * afterwards. Every guard has already run; this function only applies.
 *
 * Values are written through the native property setter and followed by `input`
 * and `change` events, because a framework-controlled field ignores a direct
 * assignment and would silently revert — a write that appears to succeed and does
 * not is the failure mode this exists to avoid.
 */
export function applyAction(
  // The two verbs that act on no element are excluded by TYPE rather than
  // handled here: `navigate` belongs to the service worker, and `list_controls`
  // describes the page rather than touching a control. Excluding them keeps
  // this switch exhaustive, so a future verb that DOES act on an element cannot
  // be added without this function being made to handle it.
  action: Extract<
    BrowserAction,
    { kind: Exclude<BrowserAction["kind"], "navigate" | "list_controls"> }
  >,
  element: Element,
): { valueAfter: string | undefined } {
  switch (action.kind) {
    case "focus_field":
      (element as HTMLElement).focus();
      element.scrollIntoView({ block: "center" });
      return { valueAfter: readValue(element) };

    case "read_field":
      return { valueAfter: readValue(element) };

    case "set_value": {
      setNativeValue(element, action.value);
      return { valueAfter: readValue(element) };
    }

    case "select_option": {
      const select = element as HTMLSelectElement;
      const option = Array.from(select.options ?? []).find(
        (o) => (o.textContent ?? "").trim().toLowerCase() === action.option.trim().toLowerCase(),
      );
      if (option === undefined) return { valueAfter: readValue(element) };
      select.selectedIndex = option.index;
      fire(element, "input");
      fire(element, "change");
      return { valueAfter: readValue(element) };
    }

    case "click_control": {
      (element as HTMLElement).click();
      return { valueAfter: readValue(element) };
    }
  }
}

function setNativeValue(element: Element, value: string): void {
  const proto = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    (element as HTMLInputElement).value = value;
  }
  fire(element, "input");
  fire(element, "change");
}

function fire(element: Element, type: "input" | "change"): void {
  element.dispatchEvent(new Event(type, { bubbles: true }));
}
