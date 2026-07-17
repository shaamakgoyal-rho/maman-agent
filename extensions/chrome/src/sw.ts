/**
 * Service worker: receives semantic event shapes from content scripts, wraps
 * them in signed envelopes, and forwards them to the desktop through the
 * native messaging host. All state that must survive service-worker restarts
 * lives in chrome.storage.local (never in module scope alone).
 */
import { newNonce, signEnvelope } from "./lib/signing.js";
import type { SemanticEventShape } from "./lib/semantic.js";

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
  return { ok: true };
}

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
