import { describe, expect, it } from "vitest";
import { capabilitiesForToken, CONTEXT_EVENT_TYPES } from "../src/metadata.js";

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * Feasibility is scored by resolving each canonical token to capabilities. It is
 * also a SAFETY bar (`min_feasibility: 0.6`) that the user cannot tune. So a token
 * vocabulary the catalog does not know about does not degrade gracefully — it
 * scores 0 and makes the pattern permanently ineligible.
 *
 * That is exactly what happened: the macOS observer emits `element_focused` and
 * `value_committed` and classifies a browser as `browser` (only the Chrome relay
 * can narrow it to `crm`), and the table had no `browser/` entry for either. On a
 * real machine, 10,439 observed events produced 438 episodes, 58 candidates, and
 * ZERO eligible ones — with nothing anywhere saying why. Every unit test passed
 * throughout, because they all used the curated `crm/*` fixtures.
 *
 * The invariant below is the one that was missing: every event type the live
 * observer can emit must, under every app category it can assign, either resolve
 * to a capability or be a declared CONTEXT event. Silence is not an option.
 */

/** Exactly what `MamanObserver/main.swift` sets `eventType` to. */
const OBSERVER_EVENT_TYPES = [
  "app_activated",
  "window_focused",
  "element_focused",
  "value_committed",
] as const;

/** Categories `categorizeApp` / the Rust classifier can assign. */
const APP_CATEGORIES = [
  "crm",
  "spreadsheet",
  "email",
  "calendar",
  "research",
  "browser",
  "other",
] as const;

/**
 * Categories where automation is genuinely possible. `other` means "a native app
 * we could not identify" — there is no capability for that and inventing one
 * would be dishonest, so it is excluded rather than mapped.
 */
const AUTOMATABLE_CATEGORIES = ["crm", "spreadsheet", "browser"] as const;

function token(category: string, eventType: string): string {
  return `macos_ax:${category}:${eventType}:AXTextField:-:-`;
}

describe("every event the live observer emits is accounted for", () => {
  it("resolves or is declared context, for every automatable category", () => {
    const unaccounted: string[] = [];
    for (const category of AUTOMATABLE_CATEGORIES) {
      for (const eventType of OBSERVER_EVENT_TYPES) {
        const resolved = capabilitiesForToken(token(category, eventType));
        const isContext = CONTEXT_EVENT_TYPES.includes(eventType);
        if (resolved.length === 0 && !isContext) {
          unaccounted.push(`${category}/${eventType}`);
        }
      }
    }
    expect(
      unaccounted,
      "These are emitted by the observer but map to nothing and are not declared " +
        "context events, so any pattern containing them scores feasibility 0 and can " +
        "never become a suggestion. Add a capability mapping or declare it context.",
    ).toEqual([]);
  });

  it("maps the two events that actually dominate real observation", () => {
    // 68% of real events were value_committed and 20% element_focused. If either
    // is unmapped under `browser`, live observation produces nothing.
    expect(capabilitiesForToken(token("browser", "value_committed")).length).toBeGreaterThan(0);
    expect(capabilitiesForToken(token("browser", "element_focused")).length).toBeGreaterThan(0);
  });

  it("offers a reversible propose step FIRST for a browser write", () => {
    // feasibilityScore inspects candidates[0] for reversibility and subtracts 0.2
    // when it is irreversible. Propose-first keeps an honest write from being
    // penalised as though it were unsupervised.
    const [first] = capabilitiesForToken(token("browser", "value_committed"));
    expect(first).toBe("browser.propose_form_fill");
  });

  it("maps a value change on a non-editable role to a READ, never a form fill", () => {
    // AXStaticText cannot hold user input: the page updated itself while the
    // user worked. Claiming a form fill there scores — and would later
    // compile — a write the workflow never contained. Both role vocabularies.
    for (const role of ["AXStaticText", "AXImage", "AXGroup", "row", "button"]) {
      expect(capabilitiesForToken(`macos_ax:browser:value_committed:${role}:-:-`), role).toEqual([
        "browser.extract_structured_fields",
      ]);
    }
    // Editable and UNKNOWN roles keep the propose-first write chain — unknown
    // stays conservative because an edit cannot be ruled out, and the chain is
    // approval-gated either way.
    for (const role of ["AXTextField", "textbox", "cell", "AXSomethingNew", "-"]) {
      expect(capabilitiesForToken(`macos_ax:browser:value_committed:${role}:-:-`)[0], role).toBe(
        "browser.propose_form_fill",
      );
    }
  });

  it("treats app and window switches as context, never as work", () => {
    for (const eventType of ["app_activated", "window_focused"]) {
      expect(CONTEXT_EVENT_TYPES).toContain(eventType);
      // And they must NOT be given a capability to flatter a feasibility score.
      for (const category of APP_CATEGORIES) {
        expect(
          capabilitiesForToken(token(category, eventType)),
          `${category}/${eventType}`,
        ).toEqual([]);
      }
    }
  });

  it("leaves an unidentifiable native app unautomatable, honestly", () => {
    // `other` is "we could not tell which app this is". Nothing should resolve.
    for (const eventType of OBSERVER_EVENT_TYPES) {
      expect(capabilitiesForToken(token("other", eventType)), `other/${eventType}`).toEqual([]);
    }
  });

  it("never resolves an unknown category or event type", () => {
    expect(capabilitiesForToken(token("banking", "value_committed"))).toEqual([]);
    expect(capabilitiesForToken(token("browser", "wire_funds"))).toEqual([]);
    expect(capabilitiesForToken("malformed")).toEqual([]);
  });
});
