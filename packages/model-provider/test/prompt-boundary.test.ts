import { describe, expect, it, vi } from "vitest";
import {
  compileInputSchema,
  namingInputSchema,
  type CompileInput,
  type NamingInput,
} from "../src/provider.js";

/**
 * THE PROMPT IS A BOUNDARY, AND IT WAS THE ONLY ONE LEFT UNGUARDED.
 *
 * "Secret material never enters logs, analytics, prompts, or AgentSpec" is a
 * standing invariant. Three of those four are enforced structurally:
 * `browserActionSchema` bounds every field with `boundedNonSecret`, the teach
 * mode redaction gate masks credential regions before egress, and the logger
 * redacts. Prompts — named explicitly in that sentence — had nothing.
 *
 * `namingInputSchema` carried the comment "Redacted structured summary — NEVER
 * raw events" over fields that were bare `z.string()`, and
 * `AnthropicModelProvider` builds its prompt as `JSON.stringify(input)` without
 * parsing the input at all. TypeScript types are erased before the wire, so the
 * comment was the entire enforcement.
 */

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function naming(over: Partial<NamingInput> = {}): NamingInput {
  return {
    generalized_intent: "update_account_records",
    app_categories: ["crm"],
    object_type: "record",
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_minutes: 11,
    redacted_steps: [
      { order: 1, app: "app", action: "chrome:crm:record_opened:row:account:account" },
    ],
    allowed_capability_ids: ["salesforce.query_records"],
    ...over,
  };
}

function compile(over: Partial<CompileInput> = {}): CompileInput {
  return {
    generalized_intent: "update_account_records",
    desired_outcome: "Keep the account list current.",
    canonical_steps: ["chrome:crm:record_opened:row:account:account"],
    allowed_capability_ids: ["salesforce.query_records"],
    budgets: { max_cost_usd: 1, max_records_written: 20 },
    ...over,
  };
}

describe("the schema refuses secret-shaped input", () => {
  it("accepts an ordinary redacted summary", () => {
    expect(namingInputSchema.safeParse(naming()).success).toBe(true);
    expect(compileInputSchema.safeParse(compile()).success).toBe(true);
  });

  it("REFUSES a credential in the user's own description", () => {
    // The likeliest real case: someone pastes an example of the work and a
    // token comes with it.
    const result = compileInputSchema.safeParse(
      compile({ desired_outcome: `Reconcile using the API key ${GITHUB_TOKEN}` }),
    );
    expect(result.success).toBe(false);
  });

  it("REFUSES a credential that reached a canonical token", () => {
    // Tokens are category-level by construction, but the guard is on the field
    // rather than on the convention — a source that ever put a captured value
    // in a segment would otherwise send it verbatim.
    expect(
      compileInputSchema.safeParse(compile({ canonical_steps: [`chrome:crm:x:y:${AWS_KEY}:z`] }))
        .success,
    ).toBe(false);
    expect(
      namingInputSchema.safeParse(
        naming({ redacted_steps: [{ order: 1, app: "app", action: `key ${AWS_KEY}` }] }),
      ).success,
    ).toBe(false);
  });

  it("REFUSES an unbounded field, which is an exfiltration channel of its own", () => {
    expect(namingInputSchema.safeParse(naming({ object_type: "x".repeat(500) })).success).toBe(
      false,
    );
    expect(
      compileInputSchema.safeParse(compile({ desired_outcome: "x".repeat(3000) })).success,
    ).toBe(false);
  });
});

describe("the provider parses before it sends", () => {
  /** Builds the provider with a stubbed SDK so nothing leaves the process. */
  async function providerWithSpy() {
    const create = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "A helper",
            summary: "It does the thing you already do by hand.",
            generalized_intent: "update_account_records",
            capability_mapping: ["salesforce.query_records"],
          }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create };
      },
    }));
    vi.resetModules();
    const { AnthropicModelProvider } = await import("../src/anthropic.js");
    const provider = new AnthropicModelProvider({
      api_key: "test-key",
      classifier_model: "c",
      compiler_model: "d",
    });
    return { provider, create };
  }

  it("SENDS NOTHING when the input carries a secret", async () => {
    // The assertion that matters. A schema that rejects but a caller that sends
    // anyway would be no protection at all.
    const { provider, create } = await providerWithSpy();
    const result = await provider.nameRecommendation(
      naming({ generalized_intent: GITHUB_TOKEN }) as NamingInput,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("policy_violation");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not repeat the rejected value in the error it reports", async () => {
    // The refusal is logged. Putting the secret in the message would place it
    // in exactly the sink this check exists to protect.
    const { provider } = await providerWithSpy();
    const result = await provider.nameRecommendation(
      naming({ generalized_intent: GITHUB_TOKEN }) as NamingInput,
    );
    if (result.ok) throw new Error("expected a refusal");
    expect(result.detail).not.toContain(GITHUB_TOKEN);
    // It still says WHICH field, so the failure is diagnosable.
    expect(result.detail).toContain("generalized_intent");
  });

  it("refuses a drafting call the same way", async () => {
    const { provider, create } = await providerWithSpy();
    const result = await provider.draftAgentPlan(
      compile({ desired_outcome: `use ${AWS_KEY}` }) as CompileInput,
    );
    expect(result.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("still sends an ordinary request", async () => {
    // The guard must not block the normal path, or naming would silently stop
    // working and every agent would fall back to its deterministic title.
    const { provider, create } = await providerWithSpy();
    const result = await provider.nameRecommendation(naming());
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("puts no secret on the wire even when the call succeeds", async () => {
    const { provider, create } = await providerWithSpy();
    await provider.nameRecommendation(naming());
    const sent = JSON.stringify(create.mock.calls[0]);
    expect(sent).not.toContain(GITHUB_TOKEN);
    expect(sent).not.toContain(AWS_KEY);
  });
});
