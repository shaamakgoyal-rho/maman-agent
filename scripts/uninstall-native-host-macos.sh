#!/usr/bin/env bash
# Removes exactly what install-native-host-macos.sh created. Prints each path.
set -euo pipefail

HOST_NAME="com.maman.browser_host"
BIN_DST="$HOME/Library/Application Support/com.maman.desktop/bin/maman-browser-host"
MANIFEST_DST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"

for path in "$BIN_DST" "$MANIFEST_DST"; do
  if [[ -f "$path" ]]; then
    rm "$path"
    echo "removed $path"
  else
    echo "not present: $path"
  fi
done
