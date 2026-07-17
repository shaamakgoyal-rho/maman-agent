import { useState } from "react";
import { product } from "@maman/config";
import { useSettings } from "../../state/settings.js";
import { invokeCommand, isTauri } from "../../lib/bridge.js";
import { Button, Card, Muted, SectionTitle, Toggle } from "../ui.js";

export function Settings() {
  const { settings, update } = useSettings();
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = async (provider: string) => {
    setConnectError(null);
    try {
      // The desktop asks the API for an authorization URL, then opens it in the
      // SYSTEM browser (never an embedded webview). Tokens never return here.
      const res = await fetch(`http://localhost:4000/v1/connectors/${provider}/authorize`, {
        method: "POST",
        headers: { "x-dev-role": "member" },
      });
      if (!res.ok) throw new Error(`connector broker unavailable (${res.status})`);
      const body = (await res.json()) as { authorization_url?: string };
      if (body.authorization_url) {
        // Opens in the system browser — never an embedded login webview.
        window.open(body.authorization_url, "_blank", "noopener");
      }
    } catch (e) {
      setConnectError(
        e instanceof Error ? e.message : "Could not start connection. Is the API running?",
      );
    }
  };

  const beginPairing = async () => {
    setPairingError(null);
    if (!isTauri()) {
      setPairingError("Pairing requires the desktop app (web preview has no native host).");
      return;
    }
    try {
      setPairingToken(await invokeCommand<string>("pairing_begin"));
    } catch (e) {
      setPairingError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Suggestions</SectionTitle>
        <div className="flex items-center justify-between py-1">
          <div>
            <p className="text-sm">Daily suggestion budget</p>
            <Muted>How many times Maman may wave at you per day.</Muted>
          </div>
          <select
            aria-label="Daily suggestion budget"
            value={settings.suggestion_budget_daily}
            onChange={(e) => void update({ suggestion_budget_daily: Number(e.target.value) })}
            className="rounded-lg border border-line bg-panel px-2 py-1 text-sm"
          >
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <div>
            <p className="text-sm">Quiet hours</p>
            <Muted>No suggestions in this window (local time).</Muted>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="time"
              aria-label="Quiet hours start"
              value={settings.quiet_hours_start}
              onChange={(e) => void update({ quiet_hours_start: e.target.value })}
              className="rounded-lg border border-line bg-panel px-2 py-1 text-sm"
            />
            <span className="text-xs text-muted">to</span>
            <input
              type="time"
              aria-label="Quiet hours end"
              value={settings.quiet_hours_end}
              onChange={(e) => void update({ quiet_hours_end: e.target.value })}
              className="rounded-lg border border-line bg-panel px-2 py-1 text-sm"
            />
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Motion</SectionTitle>
        <div className="flex items-center justify-between py-1">
          <div>
            <p className="text-sm">Animations</p>
            <Muted>“System” follows your macOS reduce-motion preference.</Muted>
          </div>
          <select
            aria-label="Animation preference"
            value={settings.reduced_motion}
            onChange={(e) =>
              void update({ reduced_motion: e.target.value as "system" | "on" | "off" })
            }
            className="rounded-lg border border-line bg-panel px-2 py-1 text-sm"
          >
            <option value="system">System</option>
            <option value="on">Reduced</option>
            <option value="off">Full</option>
          </select>
        </div>
      </Card>

      <Card>
        <SectionTitle>Shortcut & position</SectionTitle>
        <div className="flex items-center justify-between py-1">
          <p className="text-sm">Open/close panel</p>
          <kbd className="rounded border border-line bg-bg px-1.5 py-0.5 text-xs">⌃⌥P</kbd>
        </div>
        <Muted>
          Hold Maman for a moment to drag it anywhere; it snaps near screen edges and remembers its
          spot per display.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Maman Browser Relay</SectionTitle>
        <Muted>
          The Browser Relay is an accessory to the desktop app: it adds page-level understanding on
          sites you enable, one at a time. Maman works fully without it. Install it, then generate a
          one-time token (valid five minutes) and paste it into the Relay popup.
        </Muted>
        <div className="mt-2 space-y-2">
          <Button variant="secondary" onClick={() => void beginPairing()}>
            Generate pairing token
          </Button>
          {pairingToken && (
            <p className="break-all rounded-lg border border-line bg-bg p-2 font-mono text-xs">
              {pairingToken}
            </p>
          )}
          {pairingError && <p className="text-xs text-danger">{pairingError}</p>}
        </div>
      </Card>

      <Card>
        <SectionTitle>Connectors</SectionTitle>
        <Muted>
          Connect a tool to let Maman use its API — the safest, most reliable way to run a step.
          Authentication opens in your system browser; tokens are stored encrypted on the server and
          never touch this app. First use is always read-only or shadow mode.
        </Muted>
        <ul className="mt-2 space-y-1.5">
          {[
            ["Salesforce", "salesforce"],
            ["Google Sheets", "google_sheets"],
            ["Gmail (drafts only)", "gmail"],
            ["Google Calendar", "google_calendar"],
            ["Slack", "slack"],
            ["HubSpot", "hubspot"],
          ].map(([label, provider]) => (
            <li key={provider} className="flex items-center justify-between text-sm">
              <span>{label}</span>
              <Button
                variant="secondary"
                onClick={() => void connect(provider!)}
                ariaLabel={`Connect ${label}`}
              >
                Connect
              </Button>
            </li>
          ))}
        </ul>
        {connectError && <p className="mt-2 text-xs text-danger">{connectError}</p>}
        <Muted>
          Demo mode uses in-process fixtures — real OAuth activates when credentials are set.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Advanced</SectionTitle>
        <Toggle
          id="reset-onboarding"
          checked={!settings.onboarding_complete}
          onChange={(v) => void update({ onboarding_complete: !v, observation_paused: true })}
          label="Re-run onboarding"
          description="Shows the consent flow again on next open. Observation pauses until it completes."
        />
      </Card>

      <Card>
        <SectionTitle>About</SectionTitle>
        <Muted>
          {product.name} 0.1.0 (development build — unsigned, auto-update disabled). Support:{" "}
          {product.company.supportEmail}
        </Muted>
      </Card>
    </div>
  );
}
