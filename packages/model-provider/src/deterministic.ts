import {
  enforceCapabilityAllowlist,
  namingInputSchema,
  namingOutputSchema,
  type CompileInput,
  type ModelProvider,
  type ModelResult,
  type NamingInput,
  type NamingOutput,
} from "./provider.js";

/**
 * DemoModelProvider: fully deterministic, zero-credential implementation that
 * supports the complete product flow (spec requirement). Its outputs pass the
 * same validation path as real model outputs.
 */
/**
 * THE DETERMINISTIC LOCAL PROVIDER — the default, and the reason Maman needs no
 * cloud key. Naming and constrained AgentSpec generation are computed on device
 * from the observed pattern; no network call, no API key, same answer every run.
 *
 * It was called `DemoModelProvider` and lived in `demo.ts`, which made the
 * production creation path *look* like it depended on demo machinery and made
 * "no demo code in production" impossible to assert. The behaviour was always
 * deterministic and shippable; only the name was wrong. `DemoModelProvider`
 * remains as an alias so the demo arcs and their tests read as demo code.
 */
export class DeterministicModelProvider implements ModelProvider {
  readonly id = "demo" as const;

  async nameRecommendation(input: NamingInput): Promise<ModelResult<NamingOutput>> {
    const parsed = namingInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "invalid_output", detail: "invalid naming input" };
    }
    const { generalized_intent, app_categories, object_type } = parsed.data;
    const apps = app_categories.length > 0 ? app_categories.join(" and ") : "your apps";
    const updateMatch = /^update_([a-z0-9_]+)_records$/.exec(generalized_intent);
    const candidate: NamingOutput = {
      title:
        generalized_intent === "reconcile_account_list"
          ? "Reconcile account lists with Salesforce"
          : updateMatch
            ? `Update Salesforce ${updateMatch[1]} records`.slice(0, 80)
            : `Automate your ${object_type} workflow across ${apps}`.slice(0, 80),
      summary:
        `I noticed you completed a similar workflow ${parsed.data.occurrence_count} times across ` +
        `${parsed.data.distinct_day_count} ${parsed.data.distinct_day_count === 1 ? "day" : "days"}. ` +
        `The median run took ` +
        `${Math.round(parsed.data.median_duration_minutes)} minutes. I can draft a helper and ` +
        `show you what it would do before anything changes.`,
      generalized_intent,
      capability_mapping: parsed.data.allowed_capability_ids,
    };
    const validated = namingOutputSchema.safeParse(candidate);
    if (!validated.success) return { ok: false, error: "invalid_output" };
    const allowlist = enforceCapabilityAllowlist(
      validated.data.capability_mapping,
      parsed.data.allowed_capability_ids,
    );
    if (!allowlist.ok) return { ok: false, error: "policy_violation" };
    return {
      ok: true,
      value: validated.data,
      usage: { input_tokens: 0, output_tokens: 0, model_alias: "demo" },
    };
  }

  async draftAgentPlan(input: CompileInput): Promise<ModelResult<unknown>> {
    // Deterministic recipe: the compiler owns real templates; the demo
    // provider simply proposes the allowed capabilities in canonical order so
    // the full pipeline (validation, policy) is exercised without a model.
    return {
      ok: true,
      value: {
        intent: input.generalized_intent,
        steps: input.allowed_capability_ids.map((capability_id, index) => ({
          order: index + 1,
          capability_id,
        })),
      },
      usage: { input_tokens: 0, output_tokens: 0, model_alias: "demo" },
    };
  }
}
