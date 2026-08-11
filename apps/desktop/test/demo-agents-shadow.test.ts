/**
 * @vitest-environment jsdom
 *
 * SHADOW-TESTS THE SEEDED DEMO AGENTS against the real runtime.
 *
 * Reads the DEVICE's agents.json (the three "(demo)" agents seeded through the
 * trace compiler), restores them into a LocalAgentRuntime exactly as the panel
 * does at boot, and runs shadow with the page protocol mocked per-origin. This
 * is the same executor, validator and adapters the installed app uses — the
 * only fake part is the page.
 *
 * Skips (with a visible message) when no seeded store exists, so CI machines
 * without the device profile stay green.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENTS_PATH = join(homedir(), "Library/Application Support/com.maman.desktop/agents.json");

/** Per-origin page state the mocked protocol serves. */
const PAGES: Record<string, Map<string, string>> = {
  "https://app.hubspot.com": new Map([
    ["Company Domain", "acme.com"],
    ["Website", ""],
  ]),
  "https://leads.example": new Map([["Lead Source", "Webinar"]]),
  "https://acme.lightning.force.com": new Map([
    ["Renewal Date", "2026-11-01"],
    ["Renewal Owner", ""],
  ]),
};
let currentOrigin = "https://app.hubspot.com";

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => true,
  invokeCommand: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "agents_load")
      return existsSync(AGENTS_PATH) ? readFileSync(AGENTS_PATH, "utf8") : null;
    if (cmd === "agents_save") return undefined; // NEVER write back to the device store from a test
    if (cmd === "staged_runs_drain") return "[]";
    if (cmd === "agent_browser_origin") return currentOrigin;
    if (cmd === "agent_browser_evaluate") {
      const expression = args?.expression as string;
      const marker = "})(";
      const literal = expression.slice(expression.lastIndexOf(marker) + marker.length, -1);
      const { request_id, action } = JSON.parse(JSON.parse(literal) as string) as {
        request_id: string;
        action: {
          kind: string;
          target?: { name: string };
          value?: string;
          expect_current?: string;
        };
      };
      const fields = PAGES[currentOrigin]!;
      if (action.kind === "list_controls") {
        return JSON.stringify({
          request_id,
          outcome: "observed",
          observed: {
            accessible_name: "",
            match_count: fields.size,
            controls: [...fields.keys()].map((name) => ({
              role: "textbox",
              name,
              secure: false,
              editable: true,
              duplicate_count: 1,
            })),
          },
        });
      }
      const name = action.target?.name ?? "";
      if (action.kind === "read_field" && fields.has(name)) {
        return JSON.stringify({
          request_id,
          outcome: "observed",
          observed: { value_after: fields.get(name), accessible_name: name, match_count: 1 },
        });
      }
      return JSON.stringify({ request_id, outcome: "refused", refusal_reason: "target_not_found" });
    }
    return undefined;
  },
  emitAppEvent: async () => {},
  onAppEvent: async () => () => {},
}));

const { useAgents } = await import("../src/lib/agents.js");
const { useSettings } = await import("../src/state/settings.js");
const { bootAgentService, runAgentShadow, __resetAgentServiceForTests } =
  await import("../src/lib/agentService.js");

const seeded = existsSync(AGENTS_PATH)
  ? (JSON.parse(readFileSync(AGENTS_PATH, "utf8")) as { agents: Array<{ name: string }> }).agents
      .filter((a) => a.name.endsWith("(demo)"))
      .map((a) => a.name)
  : [];

describe.skipIf(seeded.length === 0)(
  "the seeded demo agents shadow-run on the real runtime",
  () => {
    async function boot() {
      __resetAgentServiceForTests();
      useAgents.setState({ agents: [], hydrated: false, loadFailure: null, discarded: 0 });
      useSettings.setState((s) => ({
        settings: {
          ...s.settings,
          browser_actuation_origins: Object.keys(PAGES),
        },
      }));
      await bootAgentService();
    }

    function agentIdByName(fragment: string): string {
      const agent = useAgents.getState().agents.find((a) => a.name.includes(fragment));
      if (!agent) throw new Error(`agent ${fragment} not restored`);
      return agent.agent_id;
    }

    it("dataflow agent: proposes the Website change without writing", async () => {
      await boot();
      currentOrigin = "https://app.hubspot.com";
      const outcome = await runAgentShadow(agentIdByName("Copy company domain"));
      // Report the honest outcome whatever it is; assert only afterwards.
      console.log("DATAFLOW AGENT:", JSON.stringify(outcome));
      expect(outcome.status).toBe("shadow_complete");
    });

    it("press-chain agent: reports its real shadow outcome", async () => {
      await boot();
      currentOrigin = "https://leads.example";
      const outcome = await runAgentShadow(agentIdByName("Assign and qualify"));
      console.log("PRESS AGENT:", JSON.stringify(outcome));
      expect(outcome.status).toBe("shadow_complete");
    });

    it("runtime-input agent: asks the one inline question", async () => {
      await boot();
      currentOrigin = "https://acme.lightning.force.com";
      const outcome = await runAgentShadow(agentIdByName("Set the renewal owner"));
      console.log("INPUT AGENT:", JSON.stringify(outcome));
      expect(outcome.status).toBe("needs_input");
      if (outcome.status !== "needs_input") throw new Error("unreachable");
      expect(outcome.detail.toLowerCase()).toContain("renewal");
    });
  },
);
