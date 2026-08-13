# Browser extension pairing

## The extension ID is pinned

`extensions/chrome/manifest.config.ts` ships a `key` (a public RSA SPKI), so
Chrome derives the SAME extension id on every machine and for every load path:

    hcfbjnjejkcmcblkbbjkplgabnmianpf

Before this was pinned, Chrome derived an unpacked extension's id from its
absolute path, so the native-host manifest could only be written by a human
running a script with their own id pasted in — which is why the relay lane was
unreachable for anyone who was not a developer. `extension-identity.test.ts`
derives the id from the committed key with Chrome's own algorithm and fails if
the two ever drift; a Rust test pins the same constant on the desktop side.

The matching PRIVATE key was never kept. It is needed only to pack a
self-distributed `.crx`, and the Web Store issues its own identity on upload,
so there is no secret to store and none is committed.

## Setup, from inside the app

Privacy & access → **Chrome connection** does the whole thing:

1. **Set up** (`browser_host_install`) writes
   `com.maman.browser_host.json` into the NativeMessagingHosts directory of
   every Chromium-family browser that is actually installed (Chrome, Chromium,
   Brave), pointing `path` at the `maman-browser-host` binary **bundled inside
   the app** and `allowed_origins` at the pinned extension id. No terminal, no
   cargo, no repo checkout.
2. **Show pairing code** (`pairing_begin`) mints the one-time token to paste
   into the extension's popup.

`browser_host_status` reports what is actually true: whether the bundled host
exists, which browsers have a manifest pointing at a binary that still exists,
and whether pairing has completed. A manifest left behind by a moved or
replaced app reads as NOT installed, because Chrome would fail to launch it.

Installing the manifest grants nothing on its own — the channel still requires
the pairing token, and the manifest carries no secret (a Rust test asserts it).

`scripts/install-native-host-macos.sh` remains for CI and headless development.

The installed manifest's `allowed_origins` is the **single source of truth** for
which extensions may reach the host: Chrome checks it before launching the host,
and the host re-reads the same file for its own allowlist (Chrome cannot pass
environment variables to a native host, so the host cannot be configured any
other way). Re-run the installer whenever the extension ID changes — Chrome
assigns unpacked builds an ID derived from their absolute path, so moving the
`dist` directory changes it.

## Pairing protocol (spec §10)

1. The installed native-host manifest allowlists only the production extension
   ID and the documented development ID (`allowed_origins`); the host derives
   its own allowlist from that same manifest.
2. The desktop generates a 32-byte base64url one-time token
   (`pairing_begin`, panel-only), stores **only its SHA-256 hash** with a
   five-minute expiry, and displays the token in Settings → Browser extension.
3. The user pastes the token into the extension popup.
4. The extension sends `pair_request` (extension ID, installation UUID, token,
   timestamp, nonce) over native messaging.
5. The host verifies Chrome supplied an allowlisted origin, then forwards
   `pair_check` to the desktop over the local Unix socket; the desktop
   verifies the token hash + expiry and consumes the token.
6. The desktop generates a separate 256-bit shared secret, stores it in the
   macOS Keychain, and returns it once over the already origin-restricted
   channel.
7. The extension stores the secret in `chrome.storage.local` and clears the
   pairing token immediately.
8. Every later message is a signed envelope: HMAC-SHA256 over canonical JSON
   of `{message_id, installation_id, timestamp, nonce, payload}` — a frozen
   cross-implementation vector is asserted in BOTH test suites
   (`extensions/chrome/test/signing.test.ts` and
   `apps/desktop/src-tauri/src/browser_bridge.rs`).
9. Messages older than 60 seconds or with a repeated nonce are rejected by the
   host (structural checks + replay cache) and the desktop verifies the HMAC —
   the host never holds key material.
10. Re-pairing overwrites the Keychain secret, invalidating the old one.
