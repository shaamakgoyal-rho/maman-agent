export {
  namingInputSchema,
  namingOutputSchema,
  compileInputSchema,
  enforceCapabilityAllowlist,
  type ModelProvider,
  type ModelResult,
  type ModelUsage,
  type NamingInput,
  type NamingOutput,
  type CompileInput,
} from "./provider.js";
export { DeterministicModelProvider } from "./deterministic.js";
export { DemoModelProvider } from "./demo.js";
export { AnthropicModelProvider, type AnthropicProviderConfig } from "./anthropic.js";
export {
  modelCostUsd,
  sumUsage,
  visionSessionPrice,
  DEFAULT_MODEL_PRICES,
  type ModelPrice,
} from "./pricing.js";

import { DeterministicModelProvider } from "./deterministic.js";
import { AnthropicModelProvider } from "./anthropic.js";
import type { ModelProvider } from "./provider.js";

/** Factory honoring MODEL_PROVIDER config; falls back to demo when unconfigured. */
export function createModelProvider(env: {
  MODEL_PROVIDER?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_CLASSIFIER_MODEL?: string | undefined;
  ANTHROPIC_COMPILER_MODEL?: string | undefined;
}): ModelProvider {
  if (env.MODEL_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
    return new AnthropicModelProvider({
      api_key: env.ANTHROPIC_API_KEY,
      classifier_model: env.ANTHROPIC_CLASSIFIER_MODEL ?? "claude-haiku-4-5-20251001",
      compiler_model: env.ANTHROPIC_COMPILER_MODEL ?? "claude-sonnet-5",
    });
  }
  return new DeterministicModelProvider();
}
