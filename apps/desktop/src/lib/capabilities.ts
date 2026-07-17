import { invokeCommand, isTauri } from "./bridge.js";
import type { LocalSettings } from "../state/settings.js";

/**
 * "Maman can currently use" — the plain-language capability snapshot.
 * No internal architecture terminology reaches ordinary users; every line is
 * an honest statement of what works right now and why something doesn't.
 */

export type CapabilityLine = {
  label: string;
  status: "active" | "off" | "attention";
  detail: string;
};

export type RelayStatus = "paired" | "not_paired" | "unavailable";

export async function browserRelayStatus(): Promise<RelayStatus> {
  if (!isTauri()) return "unavailable"; // web preview has no native host
  try {
    // Pairing mints a Keychain secret; its presence means the Relay is set up.
    const paired = await invokeCommand<boolean>("browser_relay_paired");
    return paired ? "paired" : "not_paired";
  } catch {
    return "not_paired";
  }
}

export async function capabilitySnapshot(settings: LocalSettings): Promise<CapabilityLine[]> {
  const lines: CapabilityLine[] = [];

  // Desktop observation
  lines.push(
    settings.observation_paused
      ? {
          label: "Desktop observation",
          status: "off",
          detail: "Paused — Maman is not watching anything right now.",
        }
      : {
          label: "Desktop observation",
          status: "active",
          detail:
            settings.allowlist_domains.length > 0
              ? `Watching ${settings.allowlist_domains.length} site${settings.allowlist_domains.length === 1 ? "" : "s"} you allowed.`
              : "On, but no sites are allowed yet — nothing is being observed.",
        },
  );

  // Browser Relay (Chrome)
  const relay = await browserRelayStatus();
  lines.push(
    relay === "paired"
      ? {
          label: "Chrome",
          status: "active",
          detail: "Browser Relay paired — page understanding on sites you enable, one at a time.",
        }
      : relay === "not_paired"
        ? {
            label: "Chrome",
            status: "attention",
            detail:
              "Browser Relay not paired. Maman still works fully without it — pair in Settings for page-level help.",
          }
        : {
            label: "Chrome",
            status: "off",
            detail: "Browser Relay needs the desktop app (not available in web preview).",
          },
  );

  // Connectors (demo mode: none connected until the broker flow runs)
  for (const [provider, label] of [
    ["salesforce", "Salesforce"],
    ["google_sheets", "Google Sheets"],
    ["gmail", "Gmail drafts"],
  ] as const) {
    void provider;
    lines.push({
      label,
      status: "off",
      detail: "Not connected. Maman can observe and propose, but won't claim API execution.",
    });
  }

  return lines;
}
