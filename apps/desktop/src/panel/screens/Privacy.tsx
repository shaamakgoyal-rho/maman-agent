import { useState } from "react";
import { ALLOWLIST_PRESETS, useSettings } from "../../state/settings.js";
import { Button, Card, Muted, SectionTitle, StatusPill } from "../ui.js";

export function Privacy() {
  const { settings, update } = useSettings();
  const [newDomain, setNewDomain] = useState("");

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
            <span>macOS Accessibility</span>
            <StatusPill tone="muted">Not granted (lands with desktop observation)</StatusPill>
          </div>
          <div className="flex items-center justify-between">
            <span>Screen Recording</span>
            <StatusPill tone="muted">Teach Mode only — never granted in advance</StatusPill>
          </div>
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

      <Card>
        <SectionTitle>Always off-limits</SectionTitle>
        <Muted>
          These are hard-denied in code and cannot be enabled by you or your company: macOS login
          and authorization dialogs, password managers, private/incognito windows, banking and
          payment sites, health portals, the system keychain, secure text fields, and any password,
          one-time-code, or card field. When you're in one of these, Maman sleeps and records only
          that a boundary existed — never what was behind it.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Where your data lives</SectionTitle>
        <Muted>
          On this Mac: every raw observation, encrypted with a key in your Keychain (retention: 30
          days, configurable). On the server: only redacted pattern summaries you choose to sync,
          your agents, runs, and approvals. Never screenshots, never keystrokes — those are never
          captured in the first place.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Delete</SectionTitle>
        <Muted>
          Event inspection and granular deletion arrive with the local event store (Milestone 3).
          Deleting all device data removes the local database and its Keychain key after
          confirmation.
        </Muted>
      </Card>
    </div>
  );
}
