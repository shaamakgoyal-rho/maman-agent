#!/usr/bin/env bash
# Sign the Maman desktop app with a STABLE self-signed "Maman Dev" identity.
#
# Why this exists (M18.2): Tauri's default macOS build is ad-hoc signed, so the
# app has no stable code identity. macOS keys BOTH the Accessibility (TCC) grant
# and keychain "Always Allow" to code identity — an ad-hoc app's identity is
# unstable, so every rebuild/launch loses the Accessibility grant (observation
# silently stops) and re-prompts for the login-keychain password.
#
# Signing with a stable self-signed cert fixes the ROOT cause: grant
# Accessibility + click "Always Allow" ONCE, and both persist across launches
# and future rebuilds (as long as we keep signing with the same cert). This is a
# LOCAL dev identity only — it is not a Developer ID and is not for distribution
# (proper signing/notarization is M15).
#
# Usage: bash scripts/dev-codesign.sh [/path/to/Maman.app]
#   Default target: the freshly built bundle, else /Applications/Maman.app.
set -euo pipefail

CERT_NAME="Maman Dev"
KEYCHAIN="$HOME/Library/Keychains/maman-dev.keychain-db"
KEYCHAIN_PASS="maman-dev" # local signing keychain only — not a secret
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP="${1:-}"
if [[ -z "$APP" ]]; then
  BUILT="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/Maman.app"
  if [[ -d "$BUILT" ]]; then APP="$BUILT"; else APP="/Applications/Maman.app"; fi
fi
[[ -d "$APP" ]] || { echo "error: app not found at $APP"; exit 1; }

ensure_identity() {
  if security find-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
    return 0
  fi
  echo "== creating self-signed '$CERT_NAME' code-signing identity"
  local tmp
  tmp="$(mktemp -d)"
  openssl genrsa -out "$tmp/key.pem" 2048 >/dev/null 2>&1
  cat > "$tmp/cfg" <<'CFG'
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=Maman Dev
[v3]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CFG
  openssl req -x509 -new -key "$tmp/key.pem" -days 3650 -out "$tmp/cert.pem" -config "$tmp/cfg" >/dev/null 2>&1
  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$tmp/md.p12" -passout "pass:$KEYCHAIN_PASS" -name "$CERT_NAME" >/dev/null 2>&1

  if [[ ! -f "$KEYCHAIN" ]]; then
    security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
  fi
  security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
  # Keep it unlocked (no auto-relock) so codesign never blocks on it.
  security set-keychain-settings "$KEYCHAIN"
  security import "$tmp/md.p12" -k "$KEYCHAIN" -P "$KEYCHAIN_PASS" -T /usr/bin/codesign -A
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASS" "$KEYCHAIN" >/dev/null 2>&1
  rm -rf "$tmp"
}

ensure_identity

# Make the signing keychain searchable for codesign, then restore afterwards.
OLD_LIST="$(security list-keychains -d user | sed 's/"//g' | xargs)"
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
security list-keychains -d user -s $OLD_LIST "$KEYCHAIN" >/dev/null 2>&1

echo "== signing sidecar + app with '$CERT_NAME'"
# Sign nested executables first (the Swift observer sidecar), then the bundle.
SIDECAR="$APP/Contents/MacOS/maman-observer"
[[ -f "$SIDECAR" ]] && codesign --force --timestamp=none --sign "$CERT_NAME" "$SIDECAR"
codesign --force --deep --timestamp=none --sign "$CERT_NAME" "$APP"

# Restore the original keychain search list.
security list-keychains -d user -s $OLD_LIST >/dev/null 2>&1

echo "== signature:"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|Signature|Identifier" || true
codesign --verify --deep --strict "$APP" && echo "== verify OK ($APP)"
echo ""
echo "One-time macOS grants (persist afterwards because the identity is now stable):"
echo "  1. System Settings → Privacy & Security → Accessibility → enable Maman."
echo "  2. On the first keychain prompt after launch, click \"Always Allow\"."
