import { defineManifest } from "@crxjs/vite-plugin";

/**
 * Manifest V3. Minimal permissions:
 * - storage: pairing secret + per-domain enablement live in chrome.storage.local
 * - nativeMessaging: authenticated channel to the desktop host
 * - optional_host_permissions: EVERY site is opt-in per domain at runtime;
 *   nothing is observed without an explicit user grant.
 * No remotely hosted code; all scripts are bundled.
 */
/**
 * A STABLE EXTENSION ID, so the desktop app can install the native-messaging
 * manifest by itself.
 *
 * Chrome derives an unpacked extension's id from its load PATH unless the
 * manifest pins a public key — which meant every machine got a different id,
 * and the native host's `allowed_origins` could only be written by a human
 * running a script with their own id pasted in. That is the whole reason the
 * relay lane was unreachable in production.
 *
 * With the key pinned, the id is always
 *   hcfbjnjejkcmcblkbbjkplgabnmianpf
 * (first 16 bytes of SHA-256 over this DER SPKI, nibbles mapped to a–p), so
 * the app writes a correct manifest with no terminal and no guessing.
 *
 * This is a PUBLIC key. The matching private key was never kept: it is needed
 * only to pack a self-distributed .crx, and the Web Store issues its own
 * identity on upload. There is no secret here to leak, and none is committed.
 */
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArK7s30VIJ6/VnGfkRv2cMFzF+ZDdsVRg" +
  "JlhF54QZ8DYIxwVAvXICFXtApSAHqafRWc92yR1lghJCCj3v9TvCYlXBmbFeS/n1Iy7jj6eJWnAy" +
  "iOwp1Gz2fTaOheUVrvKWFSkR5ngSxnUvCC8KJoU9ftXVGmfJYiokBMl7CdG0MscEeQFU0GcoXNS6" +
  "QxUx1nSgam7R//ULWsT89Gl40HFj+hjzTOf1I0sLxrONH3bOlmHKY1xQhQ0gwU4twk66kJqlEFM0" +
  "4komeur/QZly+pAgpaweK/G0c2NQOF/WC29y1C6cOJcAnu3mxhL/Lh7EcHJDPUJrc01hT3vCE1cg" +
  "35CFFQIDAQAB";

/** The id Chrome derives from EXTENSION_PUBLIC_KEY. Pinned so the desktop app
 *  can write the native-messaging manifest without asking the user for it. */
export const EXTENSION_ID = "hcfbjnjejkcmcblkbbjkplgabnmianpf";

export const manifestDefinition = {
  manifest_version: 3,
  key: EXTENSION_PUBLIC_KEY,
  name: "Maman Browser Relay",
  version: "0.1.0",
  description:
    "Accessory to the Maman desktop app: page understanding on sites you enable. No keystrokes, no field values, no screenshots.",
  minimum_chrome_version: "116",
  permissions: ["storage", "nativeMessaging", "scripting", "activeTab"],
  optional_host_permissions: ["https://*/*"],
  background: {
    service_worker: "src/sw.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Maman Browser Relay",
  },
  icons: {
    "128": "icons/icon-128.png",
  },
};

export default defineManifest(manifestDefinition);
