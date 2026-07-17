import { describe, expect, it } from "vitest";
import type { PatternFeatureEvent } from "@maman/contracts";
import {
  activityKey,
  addObservations,
  connectorOpportunities,
  deserializeGraph,
  emptyGraph,
  recordApproval,
  recordCorrection,
  recordFailure,
  serializeGraph,
  setConnectedProviders,
  touchObject,
  type WorkflowObjectRef,
} from "../src/index.js";

let n = 0;
function evt(overrides: Partial<PatternFeatureEvent> = {}): PatternFeatureEvent {
  n++;
  return {
    event_id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    occurred_at: "2026-07-14T10:00:00.000Z",
    monotonic_ms: n * 1000,
    source: "chrome",
    app_category: "crm",
    event_type: "record_updated",
    semantic_type: "account_field",
    duration_ms: 30_000,
    sensitivity: "internal",
    excluded_from_learning: false,
    ...overrides,
  };
}

const OWNER = "00000000-0000-7000-8000-00000000aaaa";

describe("graph building", () => {
  it("aggregates activities and transitions with timing", () => {
    const events = [
      evt({ app_category: "spreadsheet", event_type: "table_read", semantic_type: "list" }),
      evt(),
      evt(),
    ];
    const graph = addObservations(emptyGraph(OWNER), events);
    expect(Object.keys(graph.activities)).toContain("crm:record_updated:account_field");
    expect(graph.activities["crm:record_updated:account_field"]!.count).toBe(2);
    const transition = graph.transitions.find(
      (t) =>
        t.from === "spreadsheet:table_read:list" && t.to === "crm:record_updated:account_field",
    );
    expect(transition?.count).toBe(1);
    expect(transition?.median_gap_ms).toBeGreaterThan(0);
  });

  it("boundary and idle events break transition chains", () => {
    const events = [
      evt(),
      evt({ event_type: "idle_started" }),
      evt({ app_category: "email", event_type: "record_opened", semantic_type: "thread" }),
    ];
    const graph = addObservations(emptyGraph(OWNER), events);
    expect(graph.transitions).toEqual([]);
  });

  it("stores no content — only hashes, categories, counts", () => {
    const graph = addObservations(emptyGraph(OWNER), [evt(), evt()]);
    const json = serializeGraph(graph);
    expect(json).not.toMatch(/"value"|"text"|password|body|acme|lightning/i);
  });

  it("is pure: inputs are never mutated", () => {
    const base = emptyGraph(OWNER);
    addObservations(base, [evt()]);
    expect(base.activities).toEqual({});
  });
});

describe("workflow object references and signal joining", () => {
  const browserRef: WorkflowObjectRef = {
    provider: "salesforce",
    objectType: "opportunity",
    stableIdHash: "a1b2c3d4e5f6a7b8",
    source: "browser",
    urlFingerprint: "fp_lightning_opportunity",
  };

  it("joins the same object seen from browser and API into one node", () => {
    let graph = touchObject(emptyGraph(OWNER), browserRef);
    graph = touchObject(graph, { ...browserRef, source: "api" });
    expect(graph.objects.length).toBe(1);
    expect(graph.objects[0]!.touch_count).toBe(2);
    // canonical source upgrades to api; the url fingerprint is retained
    expect(graph.objects[0]!.source).toBe("api");
    expect(graph.objects[0]!.urlFingerprint).toBe("fp_lightning_opportunity");
  });

  it("different objects stay separate", () => {
    let graph = touchObject(emptyGraph(OWNER), browserRef);
    graph = touchObject(graph, { ...browserRef, stableIdHash: "ffffffffffffffff" });
    expect(graph.objects.length).toBe(2);
  });

  it("rejects malformed refs", () => {
    expect(() =>
      touchObject(emptyGraph(OWNER), { ...browserRef, stableIdHash: "short" }),
    ).toThrow();
  });
});

describe("behavior signals", () => {
  it("corrections, failures, and approvals accumulate on activities", () => {
    let graph = addObservations(emptyGraph(OWNER), [evt()]);
    const key = activityKey(evt());
    graph = recordCorrection(graph, key);
    graph = recordFailure(graph, key);
    graph = recordApproval(graph, key, true);
    graph = recordApproval(graph, key, false);
    const stats = graph.activities[key]!;
    expect(stats.correction_count).toBe(1);
    expect(stats.failure_count).toBe(1);
    expect(stats.approval_grant_count).toBe(1);
    expect(stats.approval_reject_count).toBe(1);
  });
});

describe("connector-promotion opportunities", () => {
  it("suggests a connector for a browser-heavy CRM write pattern", () => {
    const events = Array.from({ length: 18 }, () => evt());
    const graph = addObservations(emptyGraph(OWNER), events);
    const opportunities = connectorOpportunities(graph);
    expect(opportunities.length).toBe(1);
    const opp = opportunities[0]!;
    expect(opp.provider).toBe("salesforce");
    expect(opp.observation_count).toBe(18);
    expect(opp.replaces_capability_ids).toContain("salesforce.update_fields");
    expect(opp.estimated_minutes_spent_weekly).toBeGreaterThan(0);
  });

  it("connected providers are never re-suggested", () => {
    let graph = addObservations(
      emptyGraph(OWNER),
      Array.from({ length: 10 }, () => evt()),
    );
    graph = setConnectedProviders(graph, ["salesforce"]);
    expect(connectorOpportunities(graph)).toEqual([]);
  });

  it("respects the observation threshold", () => {
    const graph = addObservations(emptyGraph(OWNER), [evt(), evt()]);
    expect(connectorOpportunities(graph, { min_observations: 5 })).toEqual([]);
    expect(connectorOpportunities(graph, { min_observations: 2 }).length).toBe(1);
  });
});

describe("persistence", () => {
  it("round-trips through validated serialization", () => {
    let graph = addObservations(emptyGraph(OWNER), [evt(), evt()]);
    graph = touchObject(graph, {
      provider: "salesforce",
      objectType: "account",
      stableIdHash: "1234567890abcdef",
      source: "browser",
    });
    expect(deserializeGraph(serializeGraph(graph))).toEqual(graph);
  });

  it("rejects tampered payloads", () => {
    expect(() => deserializeGraph('{"schema_version":2}')).toThrow();
  });
});
