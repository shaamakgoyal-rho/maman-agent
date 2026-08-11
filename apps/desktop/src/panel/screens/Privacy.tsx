import { useEffect, useState } from "react";
import { APP_PRESETS, ALLOWLIST_PRESETS, useSettings } from "../../state/settings.js";
import { invokeCommand, isTauri } from "../../lib/bridge.js";
import { deleteAllEvents, deleteAppHistory, fetchTimeline } from "../../lib/events.js";
import { browserActuationOrigins } from "../../lib/browserRun.js";
import { Button, Card, Muted, SectionTitle, StatusPill, Toggle } from "../ui.js";

type ObservationStats = {
  week_start: string;
  stored: number;
  dropped_paused: number;
  dropped_denied: number;
  dropped_not_allowlisted: number;
  boundary_events: number;
  rejected_forbidden: number;
};

export function Privacy() {
  const { settings, update } = useSettings();
  const [newDomain, setNewDomain] = useState("");
  const [newOrigin, setNewOrigin] = useState("");
  const [originError, setOriginError] = useState<string | null>(null);
  const [stats, setStats] = useState<ObservationStats | null>(null);
  const [hardDenied, setHardDenied] = useState<string[]>([]);
  const [syncPreview, setSyncPreview] = useState<unknown[] | null>(null);
  const [observedApps, setObservedApps] = useState<string[]>([]);
  const [deleteResult, setDeleteResult] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri()) {
      void invokeCommand<ObservationStats>("observation_stats")
        .then(setStats)
        .catch(() => {});
      void invokeCommand<string[]>("hard_denied_list")
        .then(setHardDenied)
        .catch(() => {});
    }
    // Which apps have recorded history (drives the per-app delete list).
    void fetchTimeline(500, 0)
      .then((entries) => {
        const names = [...new Set(entries.map((e) => e.app_display_name))].filter(
          (n) => n && n !== "Private" && n !== "System",
        );
        setObservedApps(names.slice(0, 8));
      })
      .catch(() => {});
  }, []);

  const loadSyncPreview = async () => {
    if (!isTauri()) {
      setSyncPreview([]);
      return;
    }
    try {
      setSyncPreview(await invokeCommand<unknown[]>("sync_preview", { limit: 5 }));
    } catch {
      setSyncPreview([]);
    }
  };

  const wipeApp = async (app: string) => {
    const n = await deleteAppHistory(app);
    setDeleteResult(
      `Deleted ${n} events from ${app} — queued sync payloads purged, tombstone written.`,
    );
    setObservedApps((apps) => apps.filter((a) => a !== app));
  };

  const wipeAll = async () => {
    const n = await deleteAllEvents();
    setDeleteResult(
      `Deleted ${n} observed events — queued sync payloads purged, tombstones written.`,
    );
    setObservedApps([]);
  };

  const wipeDevice = async () => {
    if (!isTauri()) {
      setDeleteResult("Device wipe runs in the desktop app.");
      return;
    }
    const phrase = window.prompt(
      'This deletes the local database AND its encryption key. Type "delete-device-data" to confirm.',
    );
    if (phrase !== "delete-device-data") return;
    await invokeCommand("device_data_wipe", { confirm: phrase });
    setDeleteResult("Device data deleted — database and Keychain key are gone.");
    setObservedApps([]);
  };

  const removeDomain = (domain: string) =>
    void update({
      allowlist_domains: settings.allowlist_domains.filter((d) => d !== domain),
    });

  const addDomain = () => {
    const domain = newDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0];
    if (!domain || settings.allowlist_domains.includes(domain)) return;
    void update({ allowlist_domains: [...settings.allowlist_domains, domain] });
    setNewDomain("");
  };

  const removeActuationOrigin = (origin: string) =>
    void update({
      browser_actuation_origins: settings.browser_actuation_origins.filter((o) => o !== origin),
    });

  /**
   * Accepts only what `browserActuationOrigins` will accept, and says so when it
   * does not: an entry silently dropped later would look like the permission was
   * granted when it was not.
   */
  const addActuationOrigin = () => {
    setOriginError(null);
    const entered = newOrigin.trim();
    if (entered === "") return;
    const [origin] = browserActuationOrigins([entered]);
    if (origin === undefined) {
      setOriginError("Give the full https:// address, e.g. https://your-org.my.salesforce.com");
      return;
    }
    if (settings.browser_actuation_origins.includes(origin)) {
      setNewOrigin("");
      return;
    }
    void update({
      browser_actuation_origins: [...settings.browser_actuation_origins, origin],
    });
    setNewOrigin("");
  };

  const toggleApp = (bundleId: string, on: boolean) =>
    void update({
      allowlist_bundles: on
        ? [...new Set([...settings.allowlist_bundles, bundleId])]
        : settings.allowlist_bundles.filter((b) => b !== bundleId),
    });

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Current permissions</SectionTitle>
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span>Browser observation</span>
            <StatusPill tone={settings.allowlist_domains.length ? "success" : "muted"}>
              {settings.allowlist_domains.length
                ? `${settings.allowlist_domains.length} sites allowed`
                : "Nothing allowed"}
            </StatusPill>
          </div>
          <div className="flex items-center justify-between">
            <span>Desktop app observation</span>
            <StatusPill
              tone={
                settings.observe_all_apps || settings.allowlist_bundles.length ? "success" : "muted"
              }
            >
              {settings.observe_all_apps
                ? "All apps (except off-limits)"
                : settings.allowlist_bundles.length
                  ? `${settings.allowlist_bundles.length} apps allowed`
                  : "No apps allowed"}
            </StatusPill>
          </div>
          <div className="flex items-center justify-between">
            <span>Screen Recording</span>
            <StatusPill tone={settings.teach_mode_enabled ? "warning" : "muted"}>
              {settings.teach_mode_enabled
                ? "Teach Mode on — frames are sent to Anthropic"
                : "Teach Mode only — never granted in advance"}
            </StatusPill>
          </div>
        </div>
      </Card>

      {/* The one place in the product where data leaves the device as PIXELS, so it
          says so in the plainest words available. Everything else Maman collects is
          a derived shape; this is the picture itself. */}
      <Card>
        <SectionTitle>Teach Mode (screen capture)</SectionTitle>
        <Muted>
          Off unless you turn it on. When you start a session, Maman captures frames of the apps you
          picked and <strong>sends those pictures to Anthropic</strong> to work out what you did.
          This is the only thing Maman does that sends images of your screen anywhere. Everything
          else it collects is a shape — which kind of field, which app — never a picture.
        </Muted>
        <ul className="mt-2 space-y-1 text-[11px] text-muted">
          <li>
            · A session lasts at most 15 minutes and stops itself. There is no always-on mode.
          </li>
          <li>
            · Only the apps you pick for that session. Anything else on screen is not captured.
          </li>
          <li>
            · Before a frame is sent, Maman blanks out anything that looks like a password, card
            number, API key, one-time code or password-manager popup — and if a password field has
            focus, or too much of the screen would need blanking, the whole frame is thrown away
            instead.
          </li>
          <li>· Keystrokes are never read. Not in Teach Mode, not anywhere, not as an option.</li>
          <li>
            · Frames are never saved to disk and never synced. They are read once and dropped.
          </li>
          <li>
            · What Maman thinks it saw can be <em>wrong</em>, unlike the rest of its observation, so
            it is shown to you and low-confidence readings are discarded.
          </li>
        </ul>
        <div className="mt-2">
          <Toggle
            id="teach-mode-enabled"
            checked={settings.teach_mode_enabled}
            onChange={(on) => void update({ teach_mode_enabled: on })}
            label="Allow Teach Mode sessions"
            description="Turning this on does not start anything. It only makes starting a session possible."
          />
        </div>
      </Card>

      <Card>
        <SectionTitle>Allowed sites</SectionTitle>
        {settings.allowlist_domains.length === 0 ? (
          <Muted>Maman observes nothing until you allow a site or app.</Muted>
        ) : (
          <ul className="space-y-1">
            {settings.allowlist_domains.map((domain) => (
              <li key={domain} className="flex items-center justify-between text-sm">
                <span>{ALLOWLIST_PRESETS.find((p) => p.domain === domain)?.label ?? domain}</span>
                <Button
                  variant="ghost"
                  onClick={() => removeDomain(domain)}
                  ariaLabel={`Stop observing ${domain}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          <input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addDomain()}
            placeholder="add a domain, e.g. app.example.com"
            aria-label="Add a domain to the allowlist"
            className="flex-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm placeholder:text-muted"
          />
          <Button variant="secondary" onClick={addDomain}>
            Allow
          </Button>
        </div>
      </Card>

      {/* WRITING to a site is a separate, larger permission than watching it, so it
          is a separate list — and it is compared EXACTLY, which is why the full
          origin is required rather than a domain. While this list is empty the
          browser lane is off and a browser plan is refused rather than sent. */}
      <Card>
        <SectionTitle>Sites Maman may type into</SectionTitle>
        <Muted>
          Only for systems with no usable API. Every change is planned, shown to you action by
          action, and needs your approval — and Maman refuses password, payment and one-time-code
          fields outright. Give the full address, including https://, because it is matched exactly:
          an org on its own subdomain has to be named as such.
        </Muted>
        {settings.browser_actuation_origins.length === 0 ? (
          <Muted>No sites — Maman cannot type into anything.</Muted>
        ) : (
          <ul className="mt-1 space-y-1">
            {settings.browser_actuation_origins.map((origin) => (
              <li key={origin} className="flex items-center justify-between text-sm">
                <span className="break-all">{origin}</span>
                <Button
                  variant="ghost"
                  onClick={() => removeActuationOrigin(origin)}
                  ariaLabel={`Stop writing to ${origin}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          <input
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addActuationOrigin()}
            placeholder="full address, e.g. https://your-org.my.salesforce.com"
            aria-label="Add a site Maman may type into"
            className="flex-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm placeholder:text-muted"
          />
          <Button variant="secondary" onClick={addActuationOrigin}>
            Allow writing
          </Button>
        </div>
        {originError && <p className="mt-1 text-xs text-danger">{originError}</p>}
      </Card>

      <Card>
        <SectionTitle>Allowed apps (desktop)</SectionTitle>
        <Muted>
          Which native macOS apps Maman may observe via Accessibility — the shape of your work
          (which app, which kind of element), never keystrokes or screen pixels. Requires the macOS
          Accessibility permission. (Websites are covered by “Allowed sites” above + the Browser
          Relay.)
        </Muted>
        <div className="mt-2">
          <Toggle
            id="observe-all-apps"
            checked={settings.observe_all_apps}
            onChange={(on) => void update({ observe_all_apps: on })}
            label="Observe every app I use"
            description="Track work across all your apps and sites, including ones not on the allowlist. Always-off apps and sites (password managers, banking, private windows) and secure fields are still never observed."
          />
        </div>
        {settings.observe_all_apps ? (
          <Muted>
            Observing all apps except the always-off list below. Turn this off to pick specific apps
            instead.
          </Muted>
        ) : (
          <div className="mt-2 space-y-1">
            {APP_PRESETS.map((app) => (
              <Toggle
                key={app.bundleId}
                id={`app-${app.bundleId}`}
                checked={settings.allowlist_bundles.includes(app.bundleId)}
                onChange={(on) => toggleApp(app.bundleId, on)}
                label={app.label}
                description={app.bundleId}
              />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Not collected this week</SectionTitle>
        <Muted>
          The counters below are what Maman deliberately did NOT record — showing you what was
          dropped is how you verify the boundaries are real.
        </Muted>
        {stats ? (
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
            <span className="text-muted">Recorded (typed events)</span>
            <span className="text-right text-ink">{stats.stored}</span>
            <span className="text-muted">Dropped — app/site not on your list</span>
            <span className="text-right text-ink">{stats.dropped_not_allowlisted}</span>
            <span className="text-muted">Dropped — off-limits or private context</span>
            <span className="text-right text-ink">{stats.dropped_denied}</span>
            <span className="text-muted">Dropped — observation paused</span>
            <span className="text-right text-ink">{stats.dropped_paused}</span>
            <span className="text-muted">Boundary markers (context only, no content)</span>
            <span className="text-right text-ink">{stats.boundary_events}</span>
          </div>
        ) : (
          <Muted>Live counters are available in the desktop app.</Muted>
        )}
      </Card>

      <Card>
        <SectionTitle>Always off-limits</SectionTitle>
        <Muted>
          Structurally incapable, not policy: these contexts are hard-denied in the observation code
          itself and cannot be enabled by you or your company. When you're in one, Maman records
          only that a boundary existed — never what was behind it.
        </Muted>
        {hardDenied.length > 0 ? (
          <p className="mt-2 break-words rounded-lg border border-line bg-bg p-2 font-mono text-[10px] leading-relaxed text-muted">
            {hardDenied.join(" · ")}
          </p>
        ) : (
          <Muted>
            Password managers, banking and payment sites, health portals, the system keychain,
            login/authorization dialogs, private windows, and every password, one-time-code, or card
            field.
          </Muted>
        )}
      </Card>

      <Card>
        <SectionTitle>What would leave this device</SectionTitle>
        <Muted>
          See for yourself: the exact next payloads waiting to sync, decrypted locally. Typed events
          with coarse categories and bucketed counts — no app names, no text you typed, no images of
          your work.
        </Muted>
        <div className="mt-2">
          <Button variant="secondary" onClick={() => void loadSyncPreview()}>
            Show next sync payload
          </Button>
          {syncPreview !== null &&
            (syncPreview.length === 0 ? (
              <Muted>Nothing is queued to sync right now.</Muted>
            ) : (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-bg p-2 text-[10px] leading-relaxed text-muted">
                {JSON.stringify(syncPreview.slice(0, 3), null, 2)}
              </pre>
            ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>Where your data lives</SectionTitle>
        <Muted>
          On this Mac: every raw observation, encrypted with a key in your Keychain (retention: 30
          days, configurable). Replay traces used to test helpers against your own runs stay in a
          local-only table that is never synced. On the server: only the redacted summaries above,
          your agents, runs, and approvals.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Delete</SectionTitle>
        <Muted>
          Everything Maman learned is yours. Deleting removes local history, queued sync payloads
          for it, and writes a tombstone so the server forgets too.
        </Muted>
        {observedApps.length > 0 && (
          <div className="mt-2 space-y-1">
            {observedApps.map((app) => (
              <div key={app} className="flex items-center justify-between text-sm">
                <span>{app}</span>
                <Button
                  variant="ghost"
                  onClick={() => void wipeApp(app)}
                  ariaLabel={`Delete all history from ${app}`}
                >
                  Delete its history
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void wipeAll()}>
            Delete all observed history
          </Button>
          <Button variant="ghost" onClick={() => void wipeDevice()}>
            Delete this device's data…
          </Button>
        </div>
        {deleteResult && <p className="mt-2 text-xs text-success">{deleteResult}</p>}
      </Card>
    </div>
  );
}
