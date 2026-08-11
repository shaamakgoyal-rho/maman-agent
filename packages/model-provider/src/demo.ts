/**
 * Demo-facing alias. The implementation is the deterministic local provider —
 * see `deterministic.ts`. Kept so demo arcs and their tests name themselves
 * honestly while production imports `DeterministicModelProvider`.
 */
export { DeterministicModelProvider as DemoModelProvider } from "./deterministic.js";
