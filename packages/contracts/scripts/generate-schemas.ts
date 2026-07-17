/**
 * Generates JSON Schema files for every public contract into schemas/.
 * `--check` mode fails when the committed schemas drift from the source of truth.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { workflowEventSchema } from "../src/workflow-event.js";
import {
  patternCandidateSchema,
  patternFeatureEventSchema,
  patternSyncSummarySchema,
  workflowEpisodeSchema,
} from "../src/pattern.js";
import { recommendationSchema } from "../src/recommendation.js";
import { agentSpecSchema } from "../src/agent-spec.js";
import { policyDecisionSchema } from "../src/policy.js";
import { agentRunInputSchema } from "../src/run.js";
import { auditEventSchema } from "../src/audit.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "schemas");

const targets = [
  ["workflow-event.json", workflowEventSchema, "WorkflowEvent"],
  ["pattern-feature-event.json", patternFeatureEventSchema, "PatternFeatureEvent"],
  ["workflow-episode.json", workflowEpisodeSchema, "WorkflowEpisode"],
  ["pattern-candidate.json", patternCandidateSchema, "PatternCandidate"],
  ["pattern-sync-summary.json", patternSyncSummarySchema, "PatternSyncSummary"],
  ["recommendation.json", recommendationSchema, "Recommendation"],
  ["agent-spec.json", agentSpecSchema, "AgentSpec"],
  ["policy-decision.json", policyDecisionSchema, "PolicyDecision"],
  ["agent-run-input.json", agentRunInputSchema, "AgentRunInput"],
  ["audit-event.json", auditEventSchema, "AuditEvent"],
] as const;

const checkMode = process.argv.includes("--check");
let drift = false;

mkdirSync(outDir, { recursive: true });
for (const [filename, schema, name] of targets) {
  const json = `${JSON.stringify(zodToJsonSchema(schema, name), null, 2)}\n`;
  const path = join(outDir, filename);
  if (checkMode) {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (existing !== json) {
      console.error(`schema drift: ${filename}`);
      drift = true;
    }
  } else {
    writeFileSync(path, json);
    console.log(`wrote ${filename}`);
  }
}

if (checkMode) {
  if (drift) {
    console.error("Run `pnpm schemas:generate` and commit the result.");
    process.exit(1);
  }
  console.log("schemas match sources");
}
