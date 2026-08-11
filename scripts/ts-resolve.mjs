/**
 * Lets `node` run workspace TypeScript directly. Internal packages use ESM
 * ".js" specifiers (correct for their consumers, which bundle); Node's native
 * type stripping does not remap them, so scripts that import the real
 * packages — like seed-demo-agents — would need a bundler for two lines of
 * resolution. This hook retries a failed ".js" resolution as ".ts".
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/<script>.ts
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
