#!/usr/bin/env bash
# Installs ONLY the Maman native messaging manifest and binary into the
# documented user-level locations. Prints every path it changes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_NAME="com.maman.browser_host"
BIN_SRC="$ROOT_DIR/native/browser-host/target/release/maman-browser-host"
BIN_DIR="$HOME/Library/Application Support/com.maman.desktop/bin"
BIN_DST="$BIN_DIR/maman-browser-host"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_DST="$MANIFEST_DIR/$HOST_NAME.json"

# Extension IDs allowed to talk to the host. Defaults to the PINNED id Chrome
# derives from the committed public key in extensions/chrome/manifest.config.ts,
# which is the same on every machine — pass $1 only for a differently-keyed
# build. Normal users never run this: the app installs the manifest itself
# (Privacy & access → Chrome connection).
EXTENSION_ID="${1:-hcfbjnjejkcmcblkbbjkplgabnmianpf}"

if [[ ! -f "$BIN_SRC" ]]; then
  echo "building native host (release)…"
  (cd "$ROOT_DIR/native/browser-host" && cargo build --release)
fi

mkdir -p "$BIN_DIR" "$MANIFEST_DIR"
cp "$BIN_SRC" "$BIN_DST"
chmod 755 "$BIN_DST"
echo "installed binary  → $BIN_DST"

cat > "$MANIFEST_DST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Maman browser observation host",
  "path": "$BIN_DST",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
chmod 644 "$MANIFEST_DST"
echo "installed manifest → $MANIFEST_DST"
echo "allowed extension  → chrome-extension://$EXTENSION_ID/"
echo
echo "Uninstall anytime with scripts/uninstall-native-host-macos.sh"
