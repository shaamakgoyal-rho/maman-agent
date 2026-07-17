import { describe, expect, it } from "vitest";
import { evaluateTransition } from "../src/lifecycle.js";
import { minCronIntervalMinutes } from "../src/validator.js";

describe("lifecycle edge branches", () => {
  it("invalid transitions report a reason", () => {
    const result = evaluateTransition({ from: "draft", to: "active", actor: "user" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("not allowed");
  });

  it("system actors may degrade/revoke but never promote", () => {
    expect(evaluateTransition({ from: "active", to: "degraded", actor: "system" }).allowed).toBe(
      true,
    );
    expect(evaluateTransition({ from: "shadow", to: "draft", actor: "system" }).allowed).toBe(true);
  });
});

describe("cron edge branches", () => {
  it("single-element comma lists and empty minute fields", () => {
    expect(minCronIntervalMinutes("5,35 * * * *")).toBe(30);
    expect(minCronIntervalMinutes("")).toBeNull();
    expect(minCronIntervalMinutes("*/abc * * * *")).toBeNull();
  });
});
