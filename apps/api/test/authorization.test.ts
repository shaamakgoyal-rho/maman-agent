import { describe, expect, it } from "vitest";
import { uuidv7, type Principal } from "@maman/contracts";
import { authorize, type AuthzAction } from "../src/authorization.js";

const principal = (role: Principal["role"]): Principal => ({
  user_id: uuidv7(),
  organization_id: uuidv7(),
  role,
  auth_mode: "dev",
});

describe("authorization matrix", () => {
  it("member can manage own resources", () => {
    for (const action of [
      "patterns.read_own",
      "agents.write_own",
      "runs.approve_own",
      "roi.read_own",
    ] as AuthzAction[]) {
      expect(authorize(principal("member"), action).allowed).toBe(true);
    }
  });

  it("member cannot change organization policy", () => {
    expect(authorize(principal("member"), "org.policies.write").allowed).toBe(false);
  });

  it("member cannot read admin overview or audit", () => {
    expect(authorize(principal("member"), "org.overview.read").allowed).toBe(false);
    expect(authorize(principal("member"), "org.audit.read").allowed).toBe(false);
  });

  it("manager gets aggregates but not policy or member management", () => {
    expect(authorize(principal("manager"), "org.overview.read").allowed).toBe(true);
    expect(authorize(principal("manager"), "org.roi.read_aggregate").allowed).toBe(true);
    expect(authorize(principal("manager"), "org.policies.write").allowed).toBe(false);
    expect(authorize(principal("manager"), "org.members.manage").allowed).toBe(false);
  });

  it("org_admin manages members, policies, budgets, audit", () => {
    for (const action of [
      "org.members.manage",
      "org.policies.write",
      "org.budgets.write",
      "org.audit.export",
    ] as AuthzAction[]) {
      expect(authorize(principal("org_admin"), action).allowed).toBe(true);
    }
  });

  it("security_admin configures security but cannot touch personal resources", () => {
    expect(authorize(principal("security_admin"), "security.deny_list.write").allowed).toBe(true);
    expect(authorize(principal("security_admin"), "security.retention.write").allowed).toBe(true);
    expect(authorize(principal("security_admin"), "patterns.read_own").allowed).toBe(false);
    expect(authorize(principal("security_admin"), "agents.write_own").allowed).toBe(false);
  });

  it("billing_admin reads usage but no workflow content actions exist for it", () => {
    expect(authorize(principal("billing_admin"), "billing.usage.read").allowed).toBe(true);
    expect(authorize(principal("billing_admin"), "patterns.read_own").allowed).toBe(false);
    expect(authorize(principal("billing_admin"), "recommendations.read_own").allowed).toBe(false);
    expect(authorize(principal("billing_admin"), "org.audit.read").allowed).toBe(false);
  });

  it("no role can access another member's raw events — no such action exists", () => {
    // The action vocabulary itself contains no cross-member read. This test
    // documents that guarantee by asserting the vocabulary shape.
    const forbidden = ["events.read_other", "events.read_all", "screen.replay"];
    for (const action of forbidden) {
      for (const role of [
        "member",
        "manager",
        "org_admin",
        "security_admin",
        "billing_admin",
      ] as const) {
        expect(authorize(principal(role), action as AuthzAction).allowed).toBe(false);
      }
    }
  });
});
