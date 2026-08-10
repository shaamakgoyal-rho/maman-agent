import type { OwnWindowHost } from "@maman/browser-actuator";
import { invokeCommand, isTauri } from "./bridge.js";

/**
 * Binds the pure own-window transport to Maman's real browser window.
 *
 * This file is the ONLY place the desktop knows that "the agent's browser" is a
 * Tauri window driven from Rust. `@maman/browser-actuator` sees three async
 * functions and decides everything else, so the transport can be swapped (or
 * tested) without touching a single safety rule.
 *
 * `allowedOrigins` is passed IN rather than read here: it comes from the user's
 * settings on every action, so revoking a site takes effect on the next action
 * instead of the next restart.
 */
export function tauriAgentBrowserHost(allowedOrigins: readonly string[]): OwnWindowHost {
  const requireTauri = (): void => {
    if (!isTauri()) {
      // The web preview has no window to drive. Saying so beats a hang or a
      // fabricated "nothing changed".
      throw new Error("The agent's browser window needs the desktop app.");
    }
  };

  return {
    async navigate(url: string): Promise<void> {
      requireTauri();
      // The Rust side re-checks the URL against the allowlist and refuses any
      // non-https scheme. Passing the list every time is what makes a revoked
      // site take effect immediately.
      await invokeCommand("agent_browser_open", { url, allowedOrigins: [...allowedOrigins] });
    },

    async currentOrigin(): Promise<string | null> {
      requireTauri();
      return (await invokeCommand<string | null>("agent_browser_origin")) ?? null;
    },

    async evaluate(expression: string): Promise<unknown> {
      requireTauri();
      // Returns the page's answer verbatim. It is parsed and validated by
      // `parseAgentEnvelope` — a rejection there is the correct outcome for a
      // page that answered something unexpected.
      return invokeCommand<string>("agent_browser_evaluate", { expression });
    },
  };
}

/** Closes the agent's window. Called when a run finishes, and by the user. */
export async function closeAgentBrowser(): Promise<void> {
  if (!isTauri()) return;
  await invokeCommand("agent_browser_close");
}
