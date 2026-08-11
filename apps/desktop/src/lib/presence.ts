/**
 * USER PRESENCE — the actuator's fail-closed gate, on its own.
 *
 * A consequential write is only allowed while somebody is actually there to see
 * it. This lived in `runs.ts` next to the demo arcs, which meant the production
 * agent service imported the demo Salesforce world transitively just to ask
 * whether a window was visible. It is three lines and no demo needs it.
 *
 * Fails closed with no document (a headless process is nobody watching).
 */
export function userIsPresent(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible";
}
