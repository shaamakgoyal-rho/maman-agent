import { describe, expect, it } from "vitest";
import { branding } from "../src/lib/api.js";

describe("admin console branding", () => {
  it("uses the centralized product identity (renamable in one place)", () => {
    expect(branding.name).toBe("Maman");
    expect(branding.company.securityEmail).toContain("@");
  });
});
