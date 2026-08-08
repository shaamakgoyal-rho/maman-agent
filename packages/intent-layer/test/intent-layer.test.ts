import { describe, expect, it } from "vitest";
import {
  candidateIntents,
  describeGap,
  describeIntentPlan,
  describeIntentPlanSteps,
  describeProvenance,
  describeResolvedIntent,
  describeResolvedSteps,
  missingCapabilities,
  outstandingQuestions,
  READ_FIELDS_ON_OPEN_RECORD,
  resolveIntent,
  UPDATE_FIELD_ON_OPEN_RECORD,
  wouldBenefitFromLooking,
  type IntentEvidence,
} from "../src/index.js";

/**
 * The intent layer: what an automation NEEDS, what the agent can find out for
 * itself, and what it must say plainly rather than guess.
 *
 * `generalized_intent` used to be a bare string, so nothing could express
 * requirements and the agent's description degraded to "Helper: update account
 * records" — identical for every agent built from that intent, naming nothing a
 * user could check.
 */

const ORIGIN = "https://acme.example";

type Surface = NonNullable<IntentEvidence["surface"]>;

/** A page the agent has actually looked at. */
const surface = (controls: Array<{ name: string; role: string; value?: string }>): Surface => ({
  looked: true,
  controls: controls as Surface["controls"],
});

describe("the agent discovers what it can, and says what it cannot", () => {
  it("discovers the field from the live page — no teaching needed", () => {
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox", value: "555-0100" }]),
      supplied: { new_value: "555-0199" },
    });
    expect(resolved.executable).toBe(true);
    const field = resolved.filled.find((f) => f.kind === "field")!;
    expect(field.value).toBe("Phone");
    // The provenance matters: this was FOUND, not supplied.
    expect(field.source).toBe("discovered_on_surface");
  });

  it("REFUSES to choose between two plausible controls", () => {
    // Picking the first is how an agent types into the wrong box. The page
    // script makes the same refusal for the same reason.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([
        { name: "Phone", role: "textbox" },
        { name: "Phone", role: "textbox" },
      ]),
      supplied: { new_value: "x" },
    });
    expect(resolved.executable).toBe(false);
    const gap = resolved.unfilled.find((u) => u.kind === "field")!;
    expect(gap.reason).toBe("ambiguous_controls");
    expect(gap.detail).toMatch(/wrong box/);
  });

  it("distinguishes 'I haven't looked' from 'it isn't there'", () => {
    // Reporting a missing field before looking would be a claim it has not
    // earned, and would send the user to configure something already present.
    const notLooked = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      supplied: { new_value: "x" },
    });
    expect(notLooked.unfilled.find((u) => u.kind === "field")!.reason).toBe("not_looked_yet");
    expect(wouldBenefitFromLooking(notLooked)).toBe(true);

    const looked = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Something else", role: "textbox" }]),
      observed_semantics: ["phone"],
      supplied: { new_value: "x" },
    });
    expect(looked.unfilled.find((u) => u.kind === "field")!.reason).toBe("no_matching_control");
    expect(wouldBenefitFromLooking(looked)).toBe(false);
  });

  it("does not assume the only textbox is the one the user meant", () => {
    // "The only candidate" and "the right one" are different claims. The
    // observed workflow touched a phone field; this page has a note box. An
    // agent that writes the phone number into it has done real damage.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Internal notes", role: "textbox" }]),
      observed_semantics: ["phone"],
      supplied: { new_value: "555-0199" },
    });
    expect(resolved.executable).toBe(false);
    expect(resolved.unfilled.find((u) => u.kind === "field")!.reason).toBe("no_matching_control");
  });

  it("uses what the observer recorded to pick between several fields", () => {
    // Vocabulary from the real workflow is what makes this resolvable at all —
    // without it these three textboxes are ambiguous and nothing runs.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([
        { name: "Email", role: "textbox" },
        { name: "Phone", role: "textbox" },
        { name: "Internal notes", role: "textbox" },
      ]),
      observed_semantics: ["phone"],
      supplied: { new_value: "555-0199" },
    });
    expect(resolved.executable).toBe(true);
    expect(resolved.filled.find((f) => f.kind === "field")!.value).toBe("Phone");

    const withoutVocabulary = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([
        { name: "Email", role: "textbox" },
        { name: "Phone", role: "textbox" },
        { name: "Internal notes", role: "textbox" },
      ]),
      supplied: { new_value: "555-0199" },
    });
    expect(withoutVocabulary.executable).toBe(false);
    expect(withoutVocabulary.unfilled.find((u) => u.kind === "field")!.reason).toBe(
      "ambiguous_controls",
    );
  });

  it("vocabulary ranks real controls; it never conjures one", () => {
    // A semantic type is not evidence that a field exists. If the page has no
    // phone field, the answer is "not there" — not a fabricated target.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([]),
      observed_semantics: ["phone"],
      supplied: { new_value: "555-0199" },
    });
    expect(resolved.filled.some((f) => f.kind === "field")).toBe(false);
    expect(resolved.unfilled.find((u) => u.kind === "field")!.reason).toBe("no_matching_control");
  });

  it("asks only for what looking can never reveal", () => {
    // The field is discoverable; the VALUE the user intends to type is not on
    // any page. That reduces teaching to the one genuinely unknowable thing.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox" }]),
    });
    const questions = outstandingQuestions(resolved);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.kind).toBe("value");
    expect(questions[0]!.detail).toMatch(/tell me/);
  });

  it("ignores controls whose role the slot does not accept", () => {
    // A button named "Phone" is not a field to type into.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "button" }]),
      supplied: { new_value: "x" },
    });
    expect(resolved.executable).toBe(false);
    expect(resolved.unfilled.find((u) => u.kind === "field")!.reason).toBe("no_matching_control");
  });

  it("takes the site from the allowlisted origin, not from a guess", () => {
    const resolved = resolveIntent(READ_FIELDS_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox" }]),
    });
    const site = resolved.filled.find((f) => f.kind === "record_locator")!;
    expect(site.source).toBe("from_origin");
    expect(site.value).toBe(ORIGIN);
  });

  it("a user-supplied answer overrides discovery", () => {
    // They said it explicitly; no amount of looking at a page outranks that.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox" }]),
      supplied: { field: "Mobile", new_value: "x" },
    });
    const field = resolved.filled.find((f) => f.kind === "field")!;
    expect(field.value).toBe("Mobile");
    expect(field.source).toBe("supplied_by_user");
  });
});

describe("the description names the real work", () => {
  const ready = () =>
    resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox", value: "555-0100" }]),
      supplied: { new_value: "555-0199" },
    });

  it("says the field, the site and the value — not 'Helper: update records'", () => {
    const text = describeResolvedIntent(ready());
    expect(text).toBe(
      "Set “Phone” on acme.example to “555-0199”, then read it back to confirm it took.",
    );
    // The old generic shape must not reappear.
    expect(text).not.toMatch(/^Helper:/);
    expect(text).not.toMatch(/workflow/i);
  });

  it("does not quote a value the user has not given yet", () => {
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox" }]),
      supplied: { new_value: "" }, // present but empty: still not answered
    });
    expect(resolved.executable).toBe(false);
    expect(describeResolvedIntent(resolved)).toMatch(/tell me/);
  });

  it("NAMES THE GAP instead of making a confident claim when incomplete", () => {
    // An incomplete intent literally cannot produce the confident sentence: the
    // words are not available, so the copy degrades to what is missing.
    const resolved = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, { origin: ORIGIN });
    const text = describeResolvedIntent(resolved);
    expect(resolved.executable).toBe(false);
    expect(text).toBe(describeGap(resolved));
    // What only the user can answer is surfaced ahead of what the agent can go
    // and look up for itself.
    expect(text).toMatch(/tell me/);
  });

  it("produces a per-step plan whose every line names a real control", () => {
    const lines = describeResolvedSteps(ready());
    expect(lines).toEqual([
      "Open acme.example and wait for the page.",
      "Read “Phone” so I can show you what would change.",
      "Propose setting “Phone” to “555-0199” — nothing is written yet.",
      "After you approve, set “Phone”. This is the only write.",
      "Read “Phone” again, independently, and compare.",
    ]);
    // Exactly one line describes a write.
    expect(lines.filter((l) => /^After you approve/.test(l))).toHaveLength(1);
  });

  it("offers no plan at all for an intent that cannot run", () => {
    // A plan for an unresolved intent would be a shape, not an action — and
    // approving a shape is approving nothing.
    expect(describeResolvedSteps(resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {}))).toEqual([]);
  });

  it("says where every answer came from", () => {
    const provenance = describeProvenance(ready());
    expect(provenance).toContain("field: I found “Phone” on the page.");
    expect(provenance).toContain("new_value: you told me this.");
    expect(provenance).toContain("site: acme.example, from the sites you allowed.");
  });

  it("a read-only intent never describes a write", () => {
    const resolved = resolveIntent(READ_FIELDS_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox" }]),
    });
    const text = describeResolvedIntent(resolved);
    expect(resolved.executable).toBe(true);
    expect(text).toMatch(/^Read “Phone”/);
    expect(describeResolvedSteps(resolved).some((l) => /approve|write/i.test(l))).toBe(false);
  });
});

describe("the card is concrete before the agent has looked at anything", () => {
  // This is the state the compiler is in: it knows the workflow's semantics
  // from the observed tokens, but no page has been opened. The old copy here
  // was "Helper: update account records" — identical for every such agent.
  const atCompileTime = () =>
    resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, { observed_semantics: ["phone"] });

  it("names the field it will look for and the single write", () => {
    expect(describeIntentPlan(atCompileTime())).toBe(
      "Set the phone field on the record you have open to a value you give me, then read it back to confirm it took.",
    );
  });

  it("gives a checkable plan even with nothing resolved", () => {
    const lines = describeIntentPlanSteps(atCompileTime());
    expect(lines).toEqual([
      "Work on the record you already have open.",
      "Read the phone field so I can show you what would change.",
      "Propose setting the phone field to the value you give me — nothing is written yet.",
      "After you approve, set the phone field. This is the only write.",
      "Read the phone field again, independently, and compare.",
    ]);
    expect(lines.filter((l) => /only write/.test(l))).toHaveLength(1);
  });

  it("says so plainly when it does not even know what to look for", () => {
    // No semantics observed: the honest phrase is that the user will have to
    // point at the field, not a confident noun the agent cannot back up.
    const blind = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {});
    expect(describeIntentPlan(blind)).toContain("the field you point me at");
  });

  it("still refuses the confident sentence while unresolved", () => {
    // The plan says what a run WOULD be; the description must not claim it is
    // ready. Both are needed, and they must not be confused for each other.
    const planned = atCompileTime();
    expect(describeResolvedIntent(planned)).toBe(describeGap(planned));
    expect(describeResolvedSteps(planned)).toEqual([]);
  });

  it("becomes the identical sentence once everything resolves", () => {
    // One set of phrasing rules, so the pre-run promise and the post-resolution
    // description cannot drift into saying different things.
    const ready = resolveIntent(UPDATE_FIELD_ON_OPEN_RECORD, {
      origin: ORIGIN,
      surface: surface([{ name: "Phone", role: "textbox" }]),
      observed_semantics: ["phone"],
      supplied: { new_value: "555-0199" },
    });
    expect(describeIntentPlan(ready)).toBe(describeResolvedIntent(ready));
    expect(describeIntentPlanSteps(ready)).toEqual(describeResolvedSteps(ready));
  });

  it("a read-only intent's plan still contains no write", () => {
    const planned = resolveIntent(READ_FIELDS_ON_OPEN_RECORD, { observed_semantics: ["phone"] });
    expect(describeIntentPlanSteps(planned).some((l) => /write|approve/i.test(l))).toBe(false);
  });
});

describe("which intents an observed pattern could be", () => {
  it("offers an update intent only when a write was actually observed", () => {
    const readOnly = ["macos_ax:browser:element_focused:AXGroup:-:-"];
    expect(candidateIntents(readOnly).map((i) => i.intent_id)).toEqual([
      "read_fields_on_open_record",
    ]);

    const withWrite = [...readOnly, "macos_ax:browser:value_committed:AXTextField:-:-"];
    expect(candidateIntents(withWrite).map((i) => i.intent_id)).toContain(
      "update_field_on_open_record",
    );
  });

  it("offers nothing for work seen outside a browser or CRM", () => {
    // Proposing an automation for a surface we cannot act on would be an offer
    // that cannot be honoured.
    expect(candidateIntents(["macos_ax:other:value_committed:AXTextField:-:-"])).toEqual([]);
  });
});

describe("an intent is never offered where it cannot execute", () => {
  it("reports the capabilities a runtime is missing", () => {
    const bare = new Set<string>(["browser.extract_structured_fields"]);
    expect(missingCapabilities(UPDATE_FIELD_ON_OPEN_RECORD, bare)).toEqual([
      "browser.propose_form_fill",
      "browser.supervised_form_fill",
    ]);
  });

  it("reports nothing missing when the runtime has everything", () => {
    const full = new Set(UPDATE_FIELD_ON_OPEN_RECORD.requires_capabilities);
    expect(missingCapabilities(UPDATE_FIELD_ON_OPEN_RECORD, full)).toEqual([]);
  });

  it("a read-only intent needs only the read capability", () => {
    expect(READ_FIELDS_ON_OPEN_RECORD.requires_capabilities).toEqual([
      "browser.extract_structured_fields",
    ]);
  });
});
