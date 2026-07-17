import { defineManifest } from "@crxjs/vite-plugin";

/**
 * Manifest V3. Minimal permissions:
 * - storage: pairing secret + per-domain enablement live in chrome.storage.local
 * - nativeMessaging: authenticated channel to the desktop host
 * - optional_host_permissions: EVERY site is opt-in per domain at runtime;
 *   nothing is observed without an explicit user grant.
 * No remotely hosted code; all scripts are bundled.
 */
export const manifestDefinition = {
  manifest_version: 3,
  name: "Maman Observer",
  version: "0.1.0",
  description:
    "Semantic observation for sites you allow. No keystrokes, no field values, no screenshots.",
  minimum_chrome_version: "116",
  permissions: ["storage", "nativeMessaging", "scripting", "activeTab"],
  optional_host_permissions: ["https://*/*"],
  background: {
    service_worker: "src/sw.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Maman Observer",
  },
  icons: {
    "128": "icons/icon-128.png",
  },
};

export default defineManifest(manifestDefinition);
