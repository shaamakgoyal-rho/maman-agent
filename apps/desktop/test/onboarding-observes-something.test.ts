import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_BUNDLE_IDS, bundlesForDomains } from "../src/state/settings.js";

/**
 * A COMPLETED ONBOARDING MUST OBSERVE SOMETHING.
 *
 * The break this pins: onboarding persisted `allowlist_domains` and never
 * `allowlist_bundles`, while the Swift observer drops every event whose bundle
 * is not allowlisted (an empty list matches nothing). So a user could complete
 * the entire consent flow, tick Salesforce and Gmail, press "Finish and start
 * observing" — and Maman saw nothing at all, permanently, while the home screen
 * reported "Watching your work". No pattern could form, so no suggestion and no
 * automation could ever exist.
 */

describe("allowing a site implies the browser it runs in", () => {
  it("turns chosen sites into browser bundles the observer can actually match", () => {
    const bundles = bundlesForDomains(["salesforce.com", "mail.google.com"]);
    expect(bundles).toEqual(expect.arrayContaining([...BROWSER_BUNDLE_IDS]));
    expect(bundles).toContain("com.google.Chrome");
  });

  it("keeps 'observe nothing' honest: no sites ⇒ no bundles", () => {
    expect(bundlesForDomains([])).toEqual([]);
    // …and it does not quietly drop what the user allowed elsewhere.
    expect(bundlesForDomains([], ["com.tinyspeck.slackmacgap"])).toEqual([
      "com.tinyspeck.slackmacgap",
    ]);
  });

  it("unions with existing choices instead of replacing them, and never duplicates", () => {
    const bundles = bundlesForDomains(
      ["salesforce.com"],
      ["com.tinyspeck.slackmacgap", "com.google.Chrome"],
    );
    expect(bundles).toContain("com.tinyspeck.slackmacgap");
    expect(bundles.filter((b) => b === "com.google.Chrome")).toHaveLength(1);
  });
});

describe("the onboarding finish actually persists them", () => {
  it("writes allowlist_bundles, not only allowlist_domains", () => {
    // Source-level: the defect was a MISSING field in one update() call, which
    // no behavioural test in this repo could have caught without a full panel
    // render harness. This asserts the field is in the persisted payload.
    const onboarding = readFileSync(
      join(__dirname, "..", "src", "panel", "screens", "Onboarding.tsx"),
      "utf8",
    );
    const finishBlock = onboarding.slice(
      onboarding.indexOf("const finish ="),
      onboarding.indexOf("return (", onboarding.indexOf("const finish =")),
    );
    expect(finishBlock).toContain("allowlist_domains");
    expect(finishBlock).toContain("allowlist_bundles");
    expect(finishBlock).toContain("bundlesForDomains");
  });
});
