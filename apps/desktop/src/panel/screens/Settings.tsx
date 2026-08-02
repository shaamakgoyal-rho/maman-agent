import { useEffect, useState } from "react";
import { product } from "@maman/config";
import {
  DETECTION_LIVE_DEMO,
  DETECTION_PRODUCTION,
  detectionTuned,
  useSettings,
} from "../../state/settings.js";
import { useEnrollment } from "../../state/enrollment.js";
import { invokeCommand, isTauri } from "../../lib/bridge.js";
import { Button, Card, Muted, SectionTitle, Toggle } from "../ui.js";

/** Honest observation status — the pet never silently pretends to observe. */
const OBSERVER_STATUS_LABEL: Record<string, string> = {
  disabled: "Not observing (paused or consent not given)",
  starting: "Starting the observer…",
  observing: "Observing allowed apps",
  permission_required: "Not observing — Accessibility permission needed",
  failed: "Not observing — the observer could not start",
};

export function Settings() {
  const { settings, update } = useSettings();
  const enrollment = useEnrollment();
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectOpened, setConnectOpened] = useState<string | null>(null);
  const [observerStatus, setObserverStatus] = useState<string | null>(null);

  useEffect(() => {
    void useEnrollment.getState().refresh();
  }, []);

  // Poll the native observer status so the panel reflects it honestly.
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const tick = () => {
      invokeCommand<string>("observer_status")
        .then((s) => {
          if (active) setObserverStatus(s);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const grantAccessibility = () => {
    void invokeCommand("open_accessibility_settings").catch(() => {});
  };

  const connect = async (provider: string) => {
    setConnectError(null);
    setConnectOpened(null);
    if (!isTauri()) {
      setConnectError(
        "Connecting a tool requires the desktop app (the web preview cannot reach the API).",
      );
      return;
    }
    try {
      // The RUST core asks the API for the OAuth URL (the webview never talks
      // HTTP — CSP forbids it) and opens it in the SYSTEM browser, where you
      // sign in and the redirect back to the API completes. Tokens never return
      // here — they are stored encrypted in the server vault.
      await invokeCommand<{ authorization_url?: string; opened?: boolean }>("connector_authorize", {
        provider,
      });
      setConnectOpened(provider);
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
        <SectionTitle>Detection tuning</SectionTitle>
        <Muted>
          The bars a pattern must clear before Maman suggests a helper. Lowering them makes
          suggestions form faster (useful for a live demo); the Forming view always shows the
          effective values. Consistency, feasibility, and risk bars are fixed and cannot be
          loosened.
        </Muted>
        {detectionTuned(settings) && (
          <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning">
            Detection bars are below production defaults (demo tuning active).
          </p>
        )}
        <div className="mt-2 space-y-1.5">
          {(
            [
              {
                key: "detect_min_occurrences",
                label: "Repeats needed",
                hint: "Times a workflow must recur",
                min: 2,
                max: 20,
              },
              {
                key: "detect_min_distinct_days",
                label: "Separate days needed",
                hint: "1 = same-day suggestions allowed",
                min: 1,
                max: 14,
              },
              {
                key: "detect_min_projected_minutes_weekly",
                label: "Min. minutes saved / week",
                hint: "Projected value bar",
                min: 0,
                max: 600,
              },
              {
                key: "verify_min_runs",
                label: "Runs to prove against",
                hint: "Replay-verification volume floor",
                min: 1,
                max: 100,
              },
              {
                key: "detect_event_gap_boundary_s",
                label: "Run boundary (seconds idle)",
                hint: "A pause this long ends a run",
                min: 30,
                max: 3600,
              },
            ] as const
          ).map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-3 py-0.5">
              <div>
                <p className="text-sm">{f.label}</p>
                <Muted>{f.hint}</Muted>
              </div>
              <input
                type="number"
                aria-label={f.label}
                min={f.min}
                max={f.max}
                value={settings[f.key]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) void update({ [f.key]: v });
                }}
                className="w-20 rounded-lg border border-line bg-panel px-2 py-1 text-right text-sm"
              />
            </div>
          ))}
          <Toggle
            id="detect-split-on-restart"
            checked={settings.detect_split_on_sequence_restart}
            onChange={(v) => void update({ detect_split_on_sequence_restart: v })}
            label="Split back-to-back repetitions"
            description="Count immediate re-runs of a workflow as separate runs."
          />
        </div>
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" onClick={() => void update({ ...DETECTION_LIVE_DEMO })}>
            Live demo preset
          </Button>
          <Button variant="ghost" onClick={() => void update({ ...DETECTION_PRODUCTION })}>
            Reset to production
          </Button>
        </div>
      </Card>

      <Card>
        <SectionTitle>Status bar</SectionTitle>
        <Toggle
          id="statusbar-enabled"
          checked={settings.statusbar_enabled}
          onChange={(on) => {
            void update({ statusbar_enabled: on });
            if (isTauri()) void invokeCommand("statusbar_set_visible", { visible: on });
          }}
          label="Show the status bar while you work"
          description="A small always-on-top line: a green dot when Maman is genuinely observing, plus what it's watching, which agent is being created, and any run waiting for your approval."
        />
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
        <SectionTitle>Connect to Maman server</SectionTitle>
        {!isTauri() ? (
          <Muted>
            Enrollment runs in the desktop app (the device token lives in the macOS keychain, never
            in a browser). The web preview always runs local demo runs.
          </Muted>
        ) : (
          <>
            <Muted>
              Optional. Enroll this device to run helpers on the Maman server (durable runs,
              server-side model, connector vault) and sync redacted activity. Your device token is
              stored in the macOS keychain and never reaches this window. Local-only mode keeps
              working exactly as before.
            </Muted>
            <div className="mt-2">
              {enrollment.phase === "enrolled" || enrollment.phase === "syncing" ? (
                <div className="space-y-1.5">
                  <p className="text-sm">Enrolled ✓</p>
                  <p className="text-[11px] text-muted tabular-nums break-all">
                    device {enrollment.deviceId ?? "—"}
                    {enrollment.tokenExpiresAt
                      ? ` · token valid until ${new Date(enrollment.tokenExpiresAt).toLocaleString()}`
                      : ""}
                  </p>
                  <p className="text-[11px] text-muted">
                    {enrollment.lastSync
                      ? `Last sync: uploaded ${enrollment.lastSync.uploaded}, ${enrollment.lastSync.remaining} queued`
                      : enrollment.lastSyncAt
                        ? `Last sync ${new Date(enrollment.lastSyncAt).toLocaleString()}`
                        : "Not synced yet — auto-sync runs about once a minute."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={enrollment.phase === "syncing"}
                      onClick={() => void enrollment.syncNow()}
                    >
                      {enrollment.phase === "syncing" ? "Syncing…" : "Sync now"}
                    </Button>
                    <Button variant="ghost" onClick={() => void enrollment.unenroll()}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  disabled={enrollment.phase === "enrolling"}
                  onClick={() => void enrollment.enroll()}
                >
                  {enrollment.phase === "enrolling" ? "Enrolling…" : "Enroll this device"}
                </Button>
              )}
              {enrollment.error && (
                <p className="mt-2 text-xs text-danger">Enrollment problem: {enrollment.error}</p>
              )}
            </div>
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>Observation</SectionTitle>
        {!isTauri() ? (
          <Muted>Observation runs in the desktop app (not the web preview).</Muted>
        ) : (
          <>
            <p className="text-sm">
              {observerStatus
                ? (OBSERVER_STATUS_LABEL[observerStatus] ?? observerStatus)
                : "Checking…"}
            </p>
            {observerStatus === "permission_required" && (
              <div className="mt-2">
                <Muted>
                  Maman is not observing because macOS Accessibility permission is not granted. It
                  never guesses — grant permission to resume.
                </Muted>
                <Button variant="secondary" onClick={grantAccessibility}>
                  Grant Accessibility permission
                </Button>
              </div>
            )}
            {observerStatus === "failed" && (
              <Muted>
                The observer could not start. It will retry; nothing is observed meanwhile.
              </Muted>
            )}
          </>
        )}
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
        {connectOpened && (
          <p className="mt-2 text-xs text-success">
            Opened {connectOpened} sign-in in your browser — finish there and return here.
          </p>
        )}
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
