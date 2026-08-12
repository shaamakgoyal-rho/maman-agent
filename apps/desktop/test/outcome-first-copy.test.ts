import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE STANDARD JOURNEY SPEAKS IN OUTCOMES, NOT CONSTRUCTION.
 *
 * A nontechnical user should never be asked to "create an agent". The primary
 * suggestion action is "Automate this", the primary navigation names what
 * exists ("My automations") rather than the builder ("Agents"), and the
 * builder verb "Create agent" does not appear as user-facing copy on the
 * standard path. This is a source-level guard so the copy cannot regress
 * silently — cheaper and more stable than a full panel render, and it reads
 * the same files the user sees.
 */
const SRC = join(__dirname, "..", "src", "panel");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("the standard journey is outcome-first", () => {
  it("the one suggestion's primary action is 'Automate this', not 'Create agent'", () => {
    const mother = read("screens/Mother.tsx");
    expect(mother).toContain('"Automate this"');
    // The old builder verb is gone from Mother entirely — button AND comments,
    // so a scan cannot pass on a stale comment while the button regressed.
    expect(mother).not.toMatch(/Create agent/i);
  });

  it("shows the evidence and the time saved ON the card, not only behind 'Why this?'", () => {
    const mother = read("screens/Mother.tsx");
    // Evidence line (occurrence + days) and the plain-language time saved live
    // above the actions, so the decision needs no disclosure.
    expect(mother).toContain("occurrence_count");
    expect(mother).toContain("saves about");
    expect(mother).toContain("min a week");
  });

  it("primary navigation names automations, never 'Agents' or 'Create an Agent'", () => {
    const app = read("App.tsx");
    const tabsLine = app.split("\n").find((l) => l.includes("const TABS ="))!;
    expect(tabsLine).toContain("My automations");
    expect(tabsLine).not.toMatch(/"Agents"/);
    expect(app).not.toMatch(/Create an Agent/i);
  });

  it("the automations empty state points back to 'Automate this', not a builder", () => {
    const agents = read("screens/Agents.tsx");
    const body = agents.split("\n").find((l) => l.includes("When Maman spots")) ?? "";
    expect(body).toContain("Automate this");
    expect(agents).not.toContain("click Create agent");
  });
});
