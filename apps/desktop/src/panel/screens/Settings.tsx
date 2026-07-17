import { product } from "@maman/config";
import { useSettings } from "../../state/settings.js";
import { Card, Muted, SectionTitle, Toggle } from "../ui.js";

export function Settings() {
  const { settings, update } = useSettings();

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
        <SectionTitle>Connectors</SectionTitle>
        <Muted>
          Salesforce, Google Sheets, Gmail drafts, and Calendar drafts connect here once the
          connector milestone lands. Everything works in demo mode until then.
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
