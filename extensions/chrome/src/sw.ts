/**
 * Service worker: receives semantic event shapes from content scripts, wraps
 * them in signed envelopes, and forwards them to the desktop through the
 * native messaging host. All state that must survive service-worker restarts
 * lives in chrome.storage.local (never in module scope alone).
 */
import { newNonce, signEnvelope, verifyEnvelope } from "./lib/signing.js";
import { handleRelayMessage, RelayNonceCache, type RelayDeps } from "./lib/relay.js";
import type { SemanticEventShape } from "./lib/semantic.js";
import type { ActuationContext, ActuationOutput } from "./lib/actuate.js";
import { dispatchBrowserAction, type DispatchDeps, type TabInfo } from "./lib/dispatch.js";
import type { BrowserActionRequest } from "@maman/contracts";

const NATIVE_HOST = "com.maman.browser_host";

type StoredState = {
  installation_id?: string;
  shared_secret?: string; // base64url; set during pairing
  enabled_domains?: string[];
};

async function getState(): Promise<StoredState> {
  return (await chrome.storage.local.get([
    "installation_id",
    "shared_secret",
    "enabled_domains",
  ])) as StoredState;
}

async function ensureInstallationId(): Promise<string> {
  const state = await getState();
  if (state.installation_id) return state.installation_id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installation_id: id });
  return id;
}

/** Pairing: user pastes the one-time token from the desktop panel. */
async function pair(token: string): Promise<{ ok: boolean; error?: string }> {
  const installationId = await ensureInstallationId();
  try {
    const response = (await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      type: "pair_request",
      extension_id: chrome.runtime.id,
      installation_id: installationId,
      token,
      timestamp: new Date().toISOString(),
      nonce: newNonce(),
    })) as { ok: boolean; shared_secret?: string; error?: string };
    if (!response?.ok || !response.shared_secret) {
      return { ok: false, error: response?.error ?? "pairing rejected" };
    }
    // Store the long-lived secret; the pairing token is single-use and gone.
    await chrome.storage.local.set({ shared_secret: response.shared_secret });
    // Now that there is a secret, pushes can be verified — open the channel.
    await ensureRelayPort();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "native host unavailable" };
  }
}

async function forwardEvent(shape: SemanticEventShape): Promise<void> {
  const state = await getState();
  if (!state.shared_secret || !state.installation_id) return; // not paired yet
  const enabled = state.enabled_domains ?? [];
  if (!enabled.some((d) => shape.domain === d || shape.domain.endsWith(`.${d}`))) return;

  const envelope = await signEnvelope(
    {
      message_id: crypto.randomUUID(),
      installation_id: state.installation_id,
      timestamp: new Date().toISOString(),
      nonce: newNonce(),
      payload: { type: "semantic_event", event: shape },
    },
    state.shared_secret,
  );
  try {
    await chrome.runtime.sendNativeMessage(NATIVE_HOST, envelope);
  } catch {
    // Desktop offline: drop silently — the desktop-side outbox owns durability.
  }
}

/** Enable observation for a domain — requires the optional host permission. */
async function enableDomain(domain: string): Promise<{ ok: boolean; error?: string }> {
  const granted = await chrome.permissions.request({ origins: [`https://${domain}/*`] });
  if (!granted) return { ok: false, error: "permission declined" };
  const state = await getState();
  const domains = new Set(state.enabled_domains ?? []);
  domains.add(domain);
  await chrome.storage.local.set({ enabled_domains: [...domains] });
  // Register the content script for this origin only.
  await chrome.scripting
    .registerContentScripts([
      {
        id: `maman-${domain}`,
        matches: [`https://${domain}/*`, `https://*.${domain}/*`],
        js: ["src/content.js"],
        runAt: "document_idle",
      },
    ])
    .catch(() => {
      // Already registered — fine.
    });
  await ensureRelayPort();
  return { ok: true };
}

/**
 * Real browser APIs behind the injected surface `dispatchBrowserAction` needs.
 *
 * Spent tokens live in `chrome.storage.session`: they must survive a service-worker
 * restart within the browsing session (or a restart would let a request run twice)
 * and must NOT survive a browser restart (they are worthless by then, and the
 * desktop mints fresh ones).
 */
function chromeDispatchDeps(): DispatchDeps {
  return {
    async listTabs(): Promise<TabInfo[]> {
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((t): t is chrome.tabs.Tab & { id: number; url: string } =>
          Boolean(t.id !== undefined && t.url),
        )
        .map((t) => ({
          id: t.id,
          url: t.url,
          active: t.active,
          incognito: t.incognito,
          windowId: t.windowId,
        }));
    },
    async isWindowFocused(windowId: number): Promise<boolean> {
      try {
        return (await chrome.windows.get(windowId)).focused === true;
      } catch {
        return false;
      }
    },
    async enabledDomains(): Promise<string[]> {
      return (await getState()).enabled_domains ?? [];
    },
    async isRunPaused(runId: string): Promise<boolean> {
      const stored = (await chrome.storage.session.get("paused_runs")) as {
        paused_runs?: string[];
      };
      return (stored.paused_runs ?? []).includes(runId);
    },
    async spendAuthorization(token: string): Promise<boolean> {
      const stored = (await chrome.storage.session.get("spent_authorizations")) as {
        spent_authorizations?: string[];
      };
      const spent = new Set(stored.spent_authorizations ?? []);
      if (spent.has(token)) return false;
      spent.add(token);
      await chrome.storage.session.set({ spent_authorizations: [...spent] });
      return true;
    },
    async sendToTab(
      tabId: number,
      request: BrowserActionRequest,
      ctx: ActuationContext,
    ): Promise<ActuationOutput> {
      return (await chrome.tabs.sendMessage(tabId, {
        type: "browser_action_request",
        request,
        context: ctx,
      })) as ActuationOutput;
    },
    async navigate(tabId: number, url: string): Promise<void> {
      await chrome.tabs.update(tabId, { url });
    },
    now: () => new Date(),
  };
}

/**
 * Entry point for a `browser_action_request` that arrived from the desktop over the
 * signed native channel. Returns a signed result envelope for the host to relay
 * back; a malformed request is answered with an error rather than a result, because
 * without a valid request there is no run or step to attribute one to.
 */
export async function handleBrowserActionRequest(
  raw: unknown,
): Promise<Record<string, unknown> | { ok: false; error: string }> {
  const state = await getState();
  if (!state.shared_secret || !state.installation_id) {
    return { ok: false, error: "not paired" };
  }
  const outcome = await dispatchBrowserAction(raw, chromeDispatchDeps());
  if (!outcome.ok) return { ok: false, error: outcome.error };
  return signEnvelope(
    {
      message_id: crypto.randomUUID(),
      installation_id: state.installation_id,
      timestamp: new Date().toISOString(),
      nonce: newNonce(),
      payload: { type: "browser_action_result", result: outcome.result },
    },
    state.shared_secret,
  ) as unknown as Record<string, unknown>;
}

// ---------- persistent relay port (desktop → extension pushes) ----------

/**
 * The push channel.
 *
 * `sendNativeMessage` cannot receive a push — it launches a host, sends one
 * message, and the host dies. `connectNative` keeps one host process alive and
 * gives it a pipe it can write to at any time, which is what a desktop-initiated
 * action needs. Holding the port open also keeps this service worker alive, so
 * there is no window where an approved action arrives and nothing is listening.
 */
let relayPort: chrome.runtime.Port | null = null;
const relayNonces = new RelayNonceCache();

function relayDeps(port: chrome.runtime.Port): RelayDeps {
  return {
    sharedSecret: async () => (await getState()).shared_secret,
    verify: (envelope, secret, opts) => verifyEnvelope(envelope, secret, opts),
    perform: (request) => handleBrowserActionRequest(request),
    post: (message) => port.postMessage(message),
    now: () => Date.now(),
  };
}

/** Opens the relay port if it is not already open. Safe to call repeatedly. */
export async function ensureRelayPort(): Promise<boolean> {
  if (relayPort !== null) return true;
  const state = await getState();
  // Unpaired, there is no secret to verify pushes with, so a port would only be
  // able to receive things it must drop.
  if (!state.shared_secret || !state.installation_id) return false;

  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    return false; // host not installed
  }
  port.onMessage.addListener((message: unknown) => {
    void handleRelayMessage(message, relayNonces, relayDeps(port));
  });
  port.onDisconnect.addListener(() => {
    // Desktop restarted or the host exited. Drop the reference so the next call
    // reconnects; reconnecting eagerly here would spin if the desktop is down.
    if (relayPort === port) relayPort = null;
  });
  port.postMessage({ type: "relay_open", installation_id: state.installation_id });
  relayPort = port;
  return true;
}

// Opened at every point where a browser action could plausibly follow. Pairing and
// enabling a domain are the two moments a user goes from "cannot be actuated" to
// "can be", and the lifecycle events cover a browser restart.
chrome.runtime.onStartup.addListener(() => void ensureRelayPort());
chrome.runtime.onInstalled.addListener(() => void ensureRelayPort());

async function disableDomain(domain: string): Promise<void> {
  const state = await getState();
  await chrome.storage.local.set({
    enabled_domains: (state.enabled_domains ?? []).filter((d) => d !== domain),
  });
  await chrome.scripting.unregisterContentScripts({ ids: [`maman-${domain}`] }).catch(() => {});
  await chrome.permissions.remove({ origins: [`https://${domain}/*`] }).catch(() => {});
}

chrome.runtime.onMessage.addListener(
  (message: { type: string; [k: string]: unknown }, sender, sendResponse) => {
    void (async () => {
      switch (message.type) {
        case "semantic_event": {
          // Only accept events from our own content scripts on real tabs.
          if (!sender.tab || !sender.url) return sendResponse({ ok: false });
          await forwardEvent(message["event"] as SemanticEventShape);
          return sendResponse({ ok: true });
        }
        case "pair":
          return sendResponse(await pair(message["token"] as string));
        case "enable_domain":
          return sendResponse(await enableDomain(message["domain"] as string));
        case "disable_domain":
          await disableDomain(message["domain"] as string);
          return sendResponse({ ok: true });
        case "get_status": {
          const state = await getState();
          return sendResponse({
            paired: Boolean(state.shared_secret),
            enabled_domains: state.enabled_domains ?? [],
          });
        }
        default:
          return sendResponse({ ok: false, error: "unknown message" });
      }
    })();
    return true; // async response
  },
);
