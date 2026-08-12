/**
 * SEEDS DEMO AGENTS THROUGH THE REAL MACHINERY.
 *
 * "Mock up some agents" cannot mean fake records: the production graph refuses
 * demo fixtures, the runtime re-validates every spec on restore, and an agent
 * that only *looks* real would fall apart the moment someone clicks Test. So
 * this script does the honest version —
 *
 *   realistic LocalActionTrace
 *     → the REAL trace compiler (compileTraceToAgentSpec)
 *     → the REAL validator (validateAgentSpec)
 *     → the exact AgentRecord shape createFromSpec persists
 *     → agents.json, which the runtime restores and the Rust daemon
 *       installs triggers from at next launch
 *
 * Every seeded agent is genuinely executable: real capabilities, real trigger,
 * provenance recorded, approval bound in the spec. The only synthetic part is
 * the trace itself, and each agent's name carries a "(demo)" suffix so nobody
 * mistakes staged provenance for observed history.
 *
 * Usage:  node scripts/seed-demo-agents.ts           # seed (merges, idempotent)
 *         node scripts/seed-demo-agents.ts --remove  # remove seeded agents only
 *
 * Quit Maman first; it rereads agents.json at launch.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Direct module imports, deliberately NOT the package barrel: the barrel pulls
// in the Anthropic provider, whose parameter-property syntax Node's type
// stripping cannot erase — and a seeding script has no business loading a
// cloud provider anyway.
import {
  compileTraceToAgentSpec,
  type TraceCompileRequest,
} from "../packages/agent-runtime/src/trace-compiler.ts";
import { validateAgentSpec } from "../packages/agent-runtime/src/validator.ts";
import type { LocalActionTrace, PatternCandidate } from "../packages/contracts/src/index.ts";
import { uuidv7 } from "../packages/contracts/src/index.ts";

const AGENTS_PATH = join(homedir(), "Library/Application Support/com.maman.desktop/agents.json");
const DEMO_SUFFIX = " (demo)";
const OWNER = "00000000-0000-7000-8000-000000000001";
const ORG = "00000000-0000-7000-8000-000000000002";
const CAPABILITIES = new Set([
  "browser.extract_structured_fields",
  "browser.propose_form_fill",
  // Compiler v2 pairs every proposal with its executing write step, and
  // refuses when the write half is missing — the set must match what the
  // real registry serves or every set_value seed refuses.
  "browser.supervised_form_fill",
  "browser.press_control",
]);

type Step = LocalActionTrace["steps"][number];
const at = (m: number, s = 0) =>
  new Date(Date.UTC(2026, 7, 10, 9, m, s)).toISOString().replace("+00:00", "Z");

function step(partial: Partial<Step> & Pick<Step, "order" | "operation" | "target">): Step {
  return {
    surface: "browser_dom",
    value_binding: { kind: "none" },
    preconditions: { requires_foreground: false, requires_user_presence: false },
    ...partial,
  } as Step;
}

function trace(origin: string, path: string, steps: Step[]): LocalActionTrace {
  return {
    schema_version: 1,
    trace_id: uuidv7(),
    started_at: at(0),
    ended_at: at(4),
    apps: [{ category: "browser", origin }],
    steps: steps.map((s) => ({ ...s, origin, path_template: path })),
    protected_segments: [],
    pattern_event_refs: [],
    local_only: true,
  };
}

function candidate(sequence: string[], occurrences: number, minutes: number): PatternCandidate {
  return {
    pattern_id: uuidv7(),
    owner_user_id: OWNER,
    first_seen_at: at(0),
    last_seen_at: at(4),
    occurrence_count: occurrences,
    distinct_day_count: 3,
    median_duration_ms: minutes * 60_000,
    p90_duration_ms: minutes * 90_000,
    canonical_sequence: sequence,
    episode_ids: [],
    similarity_mean: 1,
    repeatability_score: 0.92,
    feasibility_score: 1,
    risk_score: 0.35,
    projected_minutes_saved_weekly: occurrences * minutes,
    opportunity_score: 0.7,
    status: "eligible",
  };
}

/** The three stories the demo tells, as traces the compiler accepts. */
const SEEDS: Array<{
  name: string;
  state: "shadow" | "supervised" | "active";
  draft_autonomy: boolean;
  trace: LocalActionTrace;
  candidate: PatternCandidate;
}> = [
  {
    // Story 1: the read→write routine with a recovered dataflow edge.
    name: "Copy company domain into the website field" + DEMO_SUFFIX,
    state: "active",
    draft_autonomy: true,
    trace: trace("https://app.hubspot.com", "/contacts/:id", [
      step({
        order: 1,
        operation: "read_field",
        target: { role: "textbox", accessible_name: "Company Domain", ancestry: [], menu_path: [] },
      }),
      step({
        order: 2,
        operation: "set_value",
        target: { role: "textbox", accessible_name: "Website", ancestry: [], menu_path: [] },
        value_binding: { kind: "from_step", step: 1, output: "Company Domain" },
        preconditions: { requires_foreground: true, requires_user_presence: true },
        expected_effect: { kind: "value_committed", readback: "reread_target" },
      }),
    ]),
    candidate: candidate(
      [
        "chrome:browser:record_opened:row:-:contact",
        "chrome:browser:value_committed:textbox:website:contact",
      ],
      11,
      3,
    ),
  },
  {
    // Story 2: the click-chain (press-only, no values at all).
    name: "Assign and qualify the next inbound lead" + DEMO_SUFFIX,
    state: "supervised",
    draft_autonomy: false,
    trace: trace("https://leads.example", "/leads/:id", [
      step({
        order: 1,
        operation: "read_field",
        target: { role: "textbox", accessible_name: "Lead Source", ancestry: [], menu_path: [] },
      }),
      step({
        order: 2,
        operation: "press",
        target: { role: "button", accessible_name: "Assign to me", ancestry: [], menu_path: [] },
        preconditions: { requires_foreground: true, requires_user_presence: true },
        expected_effect: { kind: "record_updated", readback: "reread_target" },
      }),
      step({
        order: 3,
        operation: "press",
        target: { role: "button", accessible_name: "Mark qualified", ancestry: [], menu_path: [] },
        preconditions: { requires_foreground: true, requires_user_presence: true },
        expected_effect: { kind: "record_updated", readback: "reread_target" },
      }),
    ]),
    candidate: candidate(
      [
        "chrome:browser:record_opened:row:-:lead",
        "chrome:browser:element_activated:button:assign:lead",
        "chrome:browser:element_activated:button:qualify:lead",
      ],
      14,
      2,
    ),
  },
  {
    // Story 3: the runtime-input slot — the "one inline question" capability.
    name: "Set the renewal owner on account records" + DEMO_SUFFIX,
    state: "shadow",
    draft_autonomy: false,
    trace: trace("https://acme.lightning.force.com", "/lightning/r/Account/:id/view", [
      step({
        order: 1,
        operation: "read_field",
        target: { role: "textbox", accessible_name: "Renewal Date", ancestry: [], menu_path: [] },
      }),
      step({
        order: 2,
        operation: "set_value",
        target: { role: "textbox", accessible_name: "Renewal Owner", ancestry: [], menu_path: [] },
        value_binding: {
          kind: "runtime_input",
          input_id: "renewal_owner",
          prompt: "Who should own this renewal?",
        },
        preconditions: { requires_foreground: true, requires_user_presence: true },
        expected_effect: { kind: "value_committed", readback: "reread_target" },
      }),
    ]),
    candidate: candidate(
      [
        "chrome:crm:record_opened:row:-:account",
        "chrome:crm:value_committed:textbox:renewal_owner:account",
      ],
      6,
      4,
    ),
  },
];

function main() {
  if (!existsSync(AGENTS_PATH)) {
    console.error(`no agents store at ${AGENTS_PATH} — has Maman run once?`);
    process.exit(1);
  }
  const file = JSON.parse(readFileSync(AGENTS_PATH, "utf8")) as {
    schema_version: number;
    agents: Array<Record<string, unknown>>;
  };

  // Idempotent either direction: seeded agents are identified by the suffix.
  const kept = file.agents.filter((a) => !(a["name"] as string)?.endsWith(DEMO_SUFFIX));
  if (process.argv.includes("--remove")) {
    writeFileSync(AGENTS_PATH, JSON.stringify({ ...file, agents: kept }));
    console.log(`removed ${file.agents.length - kept.length} demo agent(s); kept ${kept.length}`);
    return;
  }

  const records = SEEDS.map((seed) => {
    const request: TraceCompileRequest = {
      trace: seed.trace,
      pattern_id: seed.candidate.pattern_id,
      owner_user_id: OWNER,
      organization_id: ORG,
      name: seed.name,
      availableCapabilities: CAPABILITIES,
    };
    const result = compileTraceToAgentSpec(request);
    if (!result.ok) throw new Error(`${seed.name}: compiler refused — ${result.detail}`);
    // The runtime will re-validate at restore; failing here is friendlier.
    const validation = validateAgentSpec({ ...result.spec, state: seed.state });
    const spec = validation.valid ? validation.spec : result.spec;
    if (!validation.valid) {
      throw new Error(`${seed.name}: validator refused — ${JSON.stringify(validation)}`);
    }
    // The exact shape agents.ts createFromSpec persists.
    return {
      agent_id: spec.agent_id,
      name: seed.name,
      state: seed.state,
      versions: [
        {
          version_id: spec.version_id,
          version_number: 1,
          spec,
          plain_language_plan: spec.steps.map((s) => s.name),
          intent_plan: [],
          created_at: spec.created_at,
          created_by: "compiler",
        },
      ],
      created_at: spec.created_at,
      source_candidate: seed.candidate,
      server_agent_id: null,
      generalized_intent: spec.generalized_intent,
      desired_outcome: spec.description,
      approved_runs: seed.state === "active" ? 5 : 0,
      draft_autonomy: seed.draft_autonomy,
      last_triggered_at: null,
      last_run_at: null,
    };
  });

  writeFileSync(AGENTS_PATH, JSON.stringify({ ...file, agents: [...kept, ...records] }));
  console.log(
    `seeded ${records.length} demo agents (compiled + validated), kept ${kept.length} existing`,
  );
  for (const r of records) {
    const spec = r.versions[0]!.spec;
    console.log(
      `  - ${r.name} [${r.state}] trigger=${spec.trigger.type}${spec.trigger.type === "context" ? `:${spec.trigger.origin}` : ""} compiler=${spec.compiler} trace=${spec.source_trace_id?.slice(0, 13)}…`,
    );
  }
}

main();
