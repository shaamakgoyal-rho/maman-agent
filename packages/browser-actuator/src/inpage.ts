import {
  browserTargetRole,
  looksLikeSecret,
  type BrowserAction,
  type BrowserActionRequest,
  type BrowserControl,
} from "@maman/contracts";

/**
 * THE SELF-HOSTED PAGE PROTOCOL.
 *
 * Maman's own browser window has no extension and no Tauri IPC. The agent
 * drives it by evaluating one expression in the page and reading back a single
 * JSON string. That is the whole transport: no message passing, no persistent
 * content script, no injected globals left behind.
 *
 * Why this shape, and not a content script:
 *
 * - NOTHING PERSISTS. The script is an IIFE evaluated per action and it defines
 *   no globals, so page JavaScript has no Maman surface to find, call, or
 *   impersonate between actions. The extension's content script had to defend a
 *   long-lived message channel; here there is no channel to defend.
 * - THE PAGE CANNOT INITIATE. Evaluation only ever happens because the agent
 *   decided to act, after the pure core in `resolve.ts` authorised it. Page
 *   content is never a trigger, so the "page content self-triggers an action"
 *   class of attack is structural rather than filtered.
 * - THE ANSWER IS DATA. The expression returns a JSON string, parsed and
 *   re-validated on the Rust/TS side against the contract schema. The page can
 *   return anything it likes; it cannot return code, and it cannot widen what
 *   the agent believes happened.
 *
 * The script does NOT decide whether to act. Every gate — origin, presence,
 * secure-field, precondition, single-use authorisation — is already enforced by
 * the pure actuator before an expression is ever built. What the script decides
 * is only "can I find exactly one control matching this target, and is it safe
 * to touch" — the DOM-shaped half of the same question, kept here because it
 * needs a live document.
 */

/**
 * THE ACCESSIBLE-NAME RUNG ORDER — one definition, two lanes.
 *
 * A control's accessible name is the ONLY handle an agent has on it: plans name
 * targets, `confirm_name` re-states them, and `list_controls`-style discovery
 * hands the agent back a string it will later send as a target. So the name has
 * to be a property of the PAGE, not of whichever lane happens to be driving —
 * a name discovered in Maman's own window must resolve in the extension, and
 * the reverse.
 *
 * The two lanes cannot share code: this one is ES5 source evaluated inside a
 * hostile document, the other is TypeScript against a live `Element`. So the
 * behaviour is pinned by a table instead —
 * `domain/accessible-name-conformance.json`, asserted by BOTH suites. That
 * fixture is the specification; this source and
 * `extensions/chrome/src/lib/dom-adapter.ts` are two implementations of it.
 *
 * The rungs, in order, each used only when it yields non-empty text:
 *
 *   1. `aria-labelledby` — every id, in order, joined; missing ids skipped
 *   2. `aria-label`
 *   3. `label[for]`
 *   4. wrapping `<label>`
 *   5. `value`, on `input[type=submit|button|reset]` only
 *   6. `placeholder`
 *   7. `title`
 *   8. `textContent`
 *   9. `name` — last resort
 *
 * Two of those placements are the resolution of a real divergence and are load
 * bearing:
 *
 * - `name` is NOT an accessible name in any spec; it is a form-submission key,
 *   often a machine token (`Opportunity.CloseDate__c`). It stays because an
 *   otherwise-unnamed input is unaddressable without it, and an agent that gets
 *   the token back from discovery can use it verbatim. It goes LAST because it
 *   must never outrank text a human can see: this lane used to name
 *   `<button name="save">Save and close</button>` "save" while the extension
 *   named it "Save and close", and a `confirm_name` written against one lane
 *   then refused in the other.
 * - `value` moves ABOVE `title`, because for a submit input the value attribute
 *   IS the native label; `title` is a tooltip about it.
 *
 * Whitespace is collapsed (NBSP included) rather than merely trimmed. The
 * extension's names are re-normalised downstream by `normalizeName`, but this
 * lane compares `confirm_name` with exact string equality against a live
 * document, so a label wrapped across two source lines has to produce the same
 * string here as it does there.
 */
export const ACCESSIBLE_NAME_SOURCE = String.raw`function (el) {
  var norm = function (s) {
    return String(s == null ? "" : s)
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };
  var attr = function (n) {
    return el.getAttribute ? norm(el.getAttribute(n)) : "";
  };
  var doc = el.ownerDocument || document;

  var labelledBy = attr("aria-labelledby");
  if (labelledBy) {
    var ids = labelledBy.split(" ");
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      var ref = ids[i] ? doc.getElementById(ids[i]) : null;
      if (ref) parts.push(norm(ref.textContent));
    }
    var joined = norm(parts.join(" "));
    if (joined) return joined;
  }

  var ariaLabel = attr("aria-label");
  if (ariaLabel) return ariaLabel;

  if (el.id) {
    var forLabel = null;
    try {
      forLabel = doc.querySelector('label[for="' + String(el.id).replace(/["\\]/g, "\\$&") + '"]');
    } catch (e) {
      forLabel = null;
    }
    if (forLabel) {
      var forText = norm(forLabel.textContent);
      if (forText) return forText;
    }
  }

  var wrap = el.closest ? el.closest("label") : null;
  if (wrap) {
    var wrapText = norm(wrap.textContent);
    if (wrapText) return wrapText;
  }

  if (String(el.tagName).toLowerCase() === "input") {
    var type = attr("type").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") {
      var buttonValue = norm(el.value);
      if (buttonValue) return buttonValue;
    }
  }

  var placeholder = attr("placeholder");
  if (placeholder) return placeholder;

  var title = attr("title");
  if (title) return title;

  var text = norm(el.textContent);
  if (text) return text;

  return attr("name");
}`;

/** Keys the page returns. Deliberately flat and small — easy to validate. */
export interface AgentPageEnvelope {
  /** Echoed so a stale answer to a previous action can never be accepted. */
  request_id: string;
  outcome: "applied" | "observed" | "refused" | "failed";
  refusal_reason?: string;
  /**
   * Non-secret observation. A write reports BOTH values: the pair is the write's
   * evidence, and `value_after` alone cannot show that anything changed.
   */
  observed?: {
    value_before?: string;
    value_after?: string;
    accessible_name?: string;
    match_count?: number;
    /** `list_controls` only: the page's shape. Never carries values. */
    controls?: BrowserControl[];
    controls_truncated?: boolean;
  };
  /** Present on `failed`: a short, non-sensitive description. */
  detail?: string;
}

/**
 * The in-page script, as source.
 *
 * It reaches the page from HERE: `buildEvalExpression` composes it with the
 * request, the desktop passes that string to the `agent_browser_evaluate`
 * command, and Rust evaluates it in the agent window. Rust holds no copy of
 * this source, so there is no second version of it to drift.
 *
 * Constraints this source obeys, because it runs inside a hostile document:
 * - No page globals are trusted: `JSON.stringify` and friends are captured from
 *   a fresh realm where possible, because a page can redefine them.
 * - No `innerHTML`, no `eval`, no dynamic function construction.
 * - Values read back are truncated; nothing unbounded crosses the boundary.
 * - A password/secure field is refused even when the caller asked for it, so a
 *   bug upstream cannot type into a credential box.
 */
export const AGENT_PAGE_SCRIPT = String.raw`(function (requestJson) {
  "use strict";
  // A page can redefine JSON, Array.prototype methods, etc. Take the natives
  // from a detached iframe realm so the answer cannot be rewritten by the page.
  var realm = null;
  try {
    var f = document.createElement("iframe");
    f.style.display = "none";
    document.documentElement.appendChild(f);
    realm = f.contentWindow;
  } catch (e) {
    realm = null;
  }
  var J = (realm && realm.JSON) || JSON;
  var reply = function (env) {
    try {
      return J.stringify(env);
    } catch (e) {
      return '{"request_id":"","outcome":"failed","detail":"unserializable"}';
    }
  };

  var req;
  try {
    req = J.parse(requestJson);
  } catch (e) {
    return reply({ request_id: "", outcome: "failed", detail: "bad request" });
  }
  var id = typeof req.request_id === "string" ? req.request_id : "";
  var action = req.action || {};
  var refuse = function (why) {
    return reply({ request_id: id, outcome: "refused", refusal_reason: why });
  };
  var fail = function (what) {
    return reply({ request_id: id, outcome: "failed", detail: what });
  };

  var MAX_VALUE = 512;
  var clip = function (s) {
    s = String(s == null ? "" : s);
    return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) : s;
  };

  // ---- accessible name ----
  // Interpolated from ACCESSIBLE_NAME_SOURCE so this lane and the extension
  // adapter cannot drift apart unnoticed: both are pinned to
  // domain/accessible-name-conformance.json. See the note on that constant.
  var nameOf = ${ACCESSIBLE_NAME_SOURCE};

  // A field is SECURE unless it can be proven otherwise. Same rule as the
  // extension adapter: refusing a legitimate field costs a message; the other
  // mistake types into a credential box.
  var isSecure = function (el) {
    var type = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
    if (type === "password") return true;
    var ac = (el.getAttribute && (el.getAttribute("autocomplete") || "")).toLowerCase();
    if (/password|cc-|credit|cvc|cvv|one-time/.test(ac)) return true;
    var nm = ((el.getAttribute && el.getAttribute("name")) || "") + " " + (el.id || "");
    if (/pass|secret|token|otp|cvv|cvc|ssn|card/i.test(nm)) return true;
    // A contenteditable region can hold anything; treat freeform as unsafe.
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return true;
    return false;
  };

  var isVisible = function (el) {
    // Ancestor walk rather than layout: a detached/hidden subtree is invisible
    // even where getBoundingClientRect would report zeros for other reasons.
    var node = el;
    while (node && node.nodeType === 1) {
      var st = null;
      try {
        st = (realm || window).getComputedStyle
          ? window.getComputedStyle(node)
          : null;
      } catch (e) {
        st = null;
      }
      if (st && (st.display === "none" || st.visibility === "hidden")) return false;
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return false;
      if (node.hasAttribute && node.hasAttribute("hidden")) return false;
      node = node.parentNode;
    }
    return true;
  };

  var editable = function (el) {
    if (el.disabled) return false;
    if (el.readOnly) return false;
    if (el.getAttribute && el.getAttribute("aria-readonly") === "true") return false;
    return true;
  };

  var ROLE_SELECTORS = {
    // password IS matched on purpose. Excluding it made a credential box report
    // "target_not_found" — indistinguishable from a typo in the plan — instead
    // of reaching the secure-field check and refusing for the real reason. The
    // agent must be able to say "I found it and I will not touch it".
    textbox: 'input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input[type="search"],input[type="password"],input:not([type]),textarea',
    combobox: 'select,[role="combobox"]',
    checkbox: 'input[type="checkbox"],[role="checkbox"]',
    button: 'button,input[type="button"],input[type="submit"],[role="button"]',
    link: "a[href]",
    cell: 'td,[role="gridcell"],[role="cell"]',
  };

  // Find controls matching (role, name). Exact accessible-name match first;
  // a case-insensitive exact match is the only fallback. No fuzzy matching:
  // "close enough" is how an agent clicks the wrong button.
  var findAll = function (target) {
    var sel = ROLE_SELECTORS[target.role];
    if (!sel) return [];
    var nodes = [];
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
    var want = String(target.name || "");
    var wantLower = want.toLowerCase();
    var exact = [];
    var loose = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isVisible(el)) continue;
      var n = nameOf(el);
      if (n === want) exact.push(el);
      else if (n.toLowerCase() === wantLower) loose.push(el);
    }
    return exact.length > 0 ? exact : loose;
  };

  var resolveOne = function (target) {
    var matches = findAll(target);
    if (matches.length === 0) return { error: "target_not_found", count: 0 };
    if (typeof target.nth === "number") {
      if (target.nth >= matches.length) return { error: "target_not_found", count: matches.length };
      return { el: matches[target.nth], count: matches.length };
    }
    if (matches.length > 1) return { error: "target_ambiguous", count: matches.length };
    return { el: matches[0], count: 1 };
  };

  var valueOf = function (el) {
    if (el.tagName === "SELECT") {
      var opt = el.options && el.options[el.selectedIndex];
      return opt ? opt.text : "";
    }
    if (el.type === "checkbox") return el.checked ? "true" : "false";
    if ("value" in el) return el.value;
    return el.textContent || "";
  };

  // Native setter + input/change events: frameworks that own the value (React,
  // Lightning) ignore a direct assignment, and a silently-ignored write that
  // reports success is the worst possible outcome. The readback in the actuator
  // is what ultimately proves it landed.
  var setNative = function (el, value) {
    try {
      var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      el.value = value;
    }
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      /* the readback decides */
    }
  };

  try {
    switch (action.kind) {
      case "read_field":
      case "focus_field": {
        var r = resolveOne(action.target);
        if (r.error) return refuse(r.error);
        if (action.kind === "focus_field") {
          try {
            r.el.scrollIntoView({ block: "center" });
            r.el.focus({ preventScroll: true });
          } catch (e) {
            /* focus is a courtesy, not the outcome */
          }
        }
        // A secure field's VALUE is never returned, even on a read.
        var secure = isSecure(r.el);
        return reply({
          request_id: id,
          outcome: "observed",
          observed: {
            accessible_name: clip(nameOf(r.el)),
            match_count: r.count,
            ...(secure ? {} : { value_after: clip(valueOf(r.el)) }),
          },
        });
      }

      case "set_value": {
        var rs = resolveOne(action.target);
        if (rs.error) return refuse(rs.error);
        if (isSecure(rs.el)) return refuse("secure_field");
        if (!editable(rs.el)) return refuse("not_editable");
        // Optimistic concurrency, re-checked HERE, against the live DOM at the
        // instant of the write — not against the page as it was when the plan
        // was built.
        if (typeof action.expect_current === "string") {
          if (String(valueOf(rs.el)) !== action.expect_current) {
            return refuse("precondition_failed");
          }
        }
        var before = clip(valueOf(rs.el));
        setNative(rs.el, String(action.value));
        return reply({
          request_id: id,
          outcome: "applied",
          observed: {
            accessible_name: clip(nameOf(rs.el)),
            match_count: rs.count,
            value_before: before,
            value_after: clip(valueOf(rs.el)),
          },
        });
      }

      case "select_option": {
        var ro = resolveOne(action.target);
        if (ro.error) return refuse(ro.error);
        if (!editable(ro.el)) return refuse("not_editable");
        var wanted = String(action.option);
        var found = -1;
        var opts = ro.el.options || [];
        for (var k = 0; k < opts.length; k++) {
          if (opts[k].text === wanted || opts[k].value === wanted) {
            found = k;
            break;
          }
        }
        if (found < 0) return refuse("target_not_found");
        var beforeOpt = clip(valueOf(ro.el));
        ro.el.selectedIndex = found;
        try {
          ro.el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {
          /* readback decides */
        }
        return reply({
          request_id: id,
          outcome: "applied",
          observed: {
            accessible_name: clip(nameOf(ro.el)),
            match_count: ro.count,
            value_before: beforeOpt,
            value_after: clip(valueOf(ro.el)),
          },
        });
      }

      case "list_controls": {
        // The page's SHAPE, so the agent can find its own target instead of
        // being told one. No value is read here — not even for a field that
        // would be readable — because a listing is not a bulk read of the
        // record. Values still come one at a time through read_field.
        var roles = action.roles || [];
        var limit = typeof action.limit === "number" ? action.limit : 40;
        var seen = {};
        var order = [];
        for (var ri = 0; ri < roles.length; ri++) {
          var rsel = ROLE_SELECTORS[roles[ri]];
          if (!rsel) continue;
          var rnodes = [];
          try {
            rnodes = Array.prototype.slice.call(document.querySelectorAll(rsel));
          } catch (e) {
            rnodes = [];
          }
          for (var ni = 0; ni < rnodes.length; ni++) {
            var cel = rnodes[ni];
            if (!isVisible(cel)) continue;
            var cname = nameOf(cel);
            if (!cname || cname.length > 120) continue;
            var ckey = roles[ri] + " " + cname.toLowerCase();
            if (Object.prototype.hasOwnProperty.call(seen, ckey)) {
              var prev = seen[ckey];
              // Repeats collapse into a count. A caller needs to know a name is
              // ambiguous; it does not need the same line twelve times.
              prev.duplicate_count = Math.min(200, prev.duplicate_count + 1);
              prev.editable = prev.editable && editable(cel);
              prev.secure = prev.secure || isSecure(cel);
              continue;
            }
            var entry = {
              role: roles[ri],
              name: cname,
              secure: isSecure(cel),
              editable: editable(cel),
              duplicate_count: 1,
            };
            seen[ckey] = entry;
            order.push(entry);
          }
        }
        return reply({
          request_id: id,
          outcome: "observed",
          observed: {
            accessible_name: "",
            match_count: order.length,
            controls: order.slice(0, limit),
            // A caller that concluded "not on this page" from a truncated
            // listing would be wrong, so a partial answer says it is partial.
            controls_truncated: order.length > limit,
          },
        });
      }

      case "click_control": {
        var rc = resolveOne(action.target);
        if (rc.error) return refuse(rc.error);
        // The independent second statement of WHAT is being pressed. A target
        // that drifted onto a different button fails here rather than clicking.
        if (nameOf(rc.el) !== String(action.confirm_name)) return refuse("confirm_name_mismatch");
        if (rc.el.disabled) return refuse("not_editable");
        rc.el.click();
        return reply({
          request_id: id,
          outcome: "applied",
          observed: { accessible_name: clip(nameOf(rc.el)), match_count: rc.count },
        });
      }

      default:
        // navigate is performed by the host window, never by page script: a
        // page must not be able to move itself as part of an agent action.
        return fail("unsupported_in_page");
    }
  } catch (e) {
    return fail("exception");
  }
})(`;

/**
 * Builds the exact expression to evaluate in the page for one request.
 *
 * The request is embedded as a JSON *string literal*, so nothing in it is ever
 * parsed as code — a field value containing `");alert(1);//` is data, not a
 * statement. This is the one place an injection could exist, so it is the one
 * place that does no string interpolation of untrusted structure.
 */
export function buildEvalExpression(request: BrowserActionRequest): string {
  // JSON.stringify twice: once for the payload, once to make it a JS literal.
  const payloadLiteral = JSON.stringify(JSON.stringify(request));
  return `${AGENT_PAGE_SCRIPT}${payloadLiteral})`;
}

/** Actions the host performs itself; the page is never asked to do these. */
export function isHostAction(action: BrowserAction): boolean {
  return action.kind === "navigate";
}

/**
 * A page's control listing, re-derived rather than trusted.
 *
 * Every entry is rebuilt field by field from what the page said, so an answer
 * carrying extra members, a value, or a role that does not exist contributes
 * nothing. Two rules matter beyond shape:
 *
 * - A SECRET-SHAPED NAME IS DROPPED. The page chooses these strings, and this
 *   wire is relayed, receipted, and shown to the user. Dropping the entry costs
 *   a possible target; keeping it would put the string in all three places.
 *   (The contract would reject it too — but that rejects the WHOLE listing, so
 *   one hostile label would deny the agent every other control on the page.)
 * - NOTHING IS INVENTED. A malformed entry is skipped, never defaulted into
 *   something plausible — a fabricated control name is a target the agent might
 *   then try to write to.
 */
function parseControls(raw: readonly unknown[]): BrowserControl[] {
  const out: BrowserControl[] = [];
  for (const item of raw.slice(0, 60)) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const role = browserTargetRole.safeParse(c.role);
    if (!role.success) continue;
    if (typeof c.name !== "string") continue;
    const name = c.name.trim().slice(0, 120);
    if (name === "" || looksLikeSecret(name)) continue;
    if (typeof c.secure !== "boolean" || typeof c.editable !== "boolean") continue;
    const duplicates =
      typeof c.duplicate_count === "number" && Number.isFinite(c.duplicate_count)
        ? Math.max(1, Math.min(200, Math.trunc(c.duplicate_count)))
        : 1;
    out.push({
      role: role.data,
      name,
      secure: c.secure,
      editable: c.editable,
      duplicate_count: duplicates,
    });
  }
  return out;
}

/**
 * Parses what the page returned. Everything here treats the answer as hostile:
 * a page that lies can only produce a refusal or a failure, never a fabricated
 * success for a request the agent did not send.
 */
export function parseAgentEnvelope(raw: unknown, expectedRequestId: string): AgentPageEnvelope {
  const fail = (detail: string): AgentPageEnvelope => ({
    request_id: expectedRequestId,
    outcome: "failed",
    detail,
  });
  if (typeof raw !== "string") return fail("no answer from the page");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("unparseable answer from the page");
  }
  if (typeof parsed !== "object" || parsed === null) return fail("malformed answer");
  const env = parsed as Record<string, unknown>;

  // A stale or forged request_id is the replay case: refuse to attribute this
  // answer to the action we asked for.
  if (env.request_id !== expectedRequestId) return fail("answer did not match the request");

  const outcome = env.outcome;
  if (
    outcome !== "applied" &&
    outcome !== "observed" &&
    outcome !== "refused" &&
    outcome !== "failed"
  ) {
    return fail("unknown outcome from the page");
  }
  // `refused` must carry a reason and the others must not — the same invariant
  // the contract enforces, checked before it reaches the contract.
  if (outcome === "refused" && typeof env.refusal_reason !== "string") {
    return fail("refusal without a reason");
  }

  const observedRaw = env.observed;
  let observed: AgentPageEnvelope["observed"];
  if (typeof observedRaw === "object" && observedRaw !== null) {
    const o = observedRaw as Record<string, unknown>;
    observed = {
      ...(typeof o.value_before === "string" ? { value_before: o.value_before.slice(0, 512) } : {}),
      ...(typeof o.value_after === "string" ? { value_after: o.value_after.slice(0, 512) } : {}),
      ...(typeof o.accessible_name === "string"
        ? { accessible_name: o.accessible_name.slice(0, 120) }
        : {}),
      ...(typeof o.match_count === "number" && Number.isFinite(o.match_count)
        ? { match_count: Math.max(0, Math.min(1000, Math.trunc(o.match_count))) }
        : {}),
      ...(Array.isArray(o.controls) ? { controls: parseControls(o.controls) } : {}),
      ...(typeof o.controls_truncated === "boolean"
        ? { controls_truncated: o.controls_truncated }
        : {}),
    };
  }

  return {
    request_id: expectedRequestId,
    outcome,
    ...(outcome === "refused" ? { refusal_reason: String(env.refusal_reason) } : {}),
    ...(observed ? { observed } : {}),
    ...(typeof env.detail === "string" ? { detail: env.detail.slice(0, 200) } : {}),
  };
}
