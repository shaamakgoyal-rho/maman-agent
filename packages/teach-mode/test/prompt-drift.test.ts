import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHIPPED_VISION_DEFAULTS } from "../src/cost.js";

/**
 * The cost shown to a user is arithmetic over the length of the prompt that
 * actually ships. That prompt lives in Rust, and the number lives here.
 *
 * Nothing else connects them, so editing `VISION_SYSTEM_PROMPT` would silently
 * make the panel quote a price the feature no longer has. This test is the link:
 * it reads the real constant and fails when the estimate has drifted away from it.
 */
const VISION_RS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "apps",
  "desktop",
  "src-tauri",
  "src",
  "vision.rs",
);

/** Reassembles the `concat!(...)` literal into the string that is actually sent. */
function shippedPrompt(): string {
  const src = readFileSync(VISION_RS, "utf8");
  const block = /pub const VISION_SYSTEM_PROMPT: &str = concat!\(([\s\S]*?)\n\);/.exec(src);
  if (block === null) {
    throw new Error(
      "VISION_SYSTEM_PROMPT not found in vision.rs — the cost estimate has lost its anchor",
    );
  }
  return [...block[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
    .join("");
}

/** ~3.7 characters per token for English prose, which is what this prompt is. */
const CHARS_PER_TOKEN = 3.7;

describe("the cost estimate stays anchored to the prompt that ships", () => {
  const prompt = shippedPrompt();

  it("finds the real prompt rather than skipping when it cannot", () => {
    expect(prompt.length).toBeGreaterThan(800);
    expect(prompt).toContain("VISIBLE LABEL");
  });

  it("keeps systemPromptTokens within 15% of the real prompt's size", () => {
    const measured = prompt.length / CHARS_PER_TOKEN;
    const drift = Math.abs(SHIPPED_VISION_DEFAULTS.systemPromptTokens - measured) / measured;
    expect(
      drift,
      `SHIPPED_VISION_DEFAULTS.systemPromptTokens is ${SHIPPED_VISION_DEFAULTS.systemPromptTokens} ` +
        `but the prompt measures ~${Math.round(measured)} tokens (${prompt.length} chars). ` +
        "Update the constant so the cost the panel shows stays true.",
    ).toBeLessThan(0.15);
  });

  it("still forbids what the schema cannot express, so the prompt and contract agree", () => {
    // A prompt that solicited risk or value would waste tokens being refused by a
    // schema with nowhere to put them.
    for (const forbidden of ["risk", "automat", "eligib", "minutes saved"]) {
      expect(prompt.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // And it must still say the two things that keep a reply safe and honest.
    expect(prompt).toContain("never speculate");
    expect(prompt).toContain("uncertain to true");
  });
});
