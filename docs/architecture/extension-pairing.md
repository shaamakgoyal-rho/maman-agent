# Browser extension pairing

## Development extension ID

Unpacked development builds use the placeholder allowlist entry
`maman-dev-extension-id`. After loading `extensions/chrome/dist` unpacked,
Chrome assigns a real ID — pass it to the installer:

```bash
scripts/install-native-host-macos.sh <your-dev-extension-id>
```

The production extension ID is set the same way once the extension is packed
and published; it also lands in `packages/config/src/product.ts`
(`chrome.productionExtensionId`).

## Pairing protocol (spec §10)

1. The installed native-host manifest allowlists only the production extension
   ID and the documented development ID (`allowed_origins`).
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
