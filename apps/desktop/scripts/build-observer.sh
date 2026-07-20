#!/usr/bin/env bash
# Builds the Swift semantic-observer sidecar and stages it for Tauri bundling.
#
# Tauri's `externalBin` expects the binary at
#   src-tauri/binaries/maman-observer-<target-triple>
# so it can bundle the right build per platform. We build a release binary from
# native/macos-observer and copy it into place.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OBSERVER_DIR="$ROOT_DIR/native/macos-observer"
DEST_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"
mkdir -p "$DEST_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-observer: not macOS — skipping (the observer sidecar is macOS-only)."
  exit 0
fi
if ! command -v swift >/dev/null 2>&1; then
  echo "build-observer: swift toolchain not found — skipping." >&2
  exit 0
fi

# The target triple Tauri appends (matches the Rust host triple).
TRIPLE="$(rustc -vV 2>/dev/null | awk '/host:/ {print $2}')"
if [[ -z "$TRIPLE" ]]; then
  ARCH="$(uname -m)"; [[ "$ARCH" == "arm64" ]] && ARCH="aarch64"
  TRIPLE="${ARCH}-apple-darwin"
fi

echo "build-observer: swift build -c release (native/macos-observer)"
( cd "$OBSERVER_DIR" && swift build -c release --product maman-observer )
BIN="$OBSERVER_DIR/.build/release/maman-observer"
[[ -f "$BIN" ]] || { echo "build-observer: binary not produced at $BIN" >&2; exit 1; }

cp "$BIN" "$DEST_DIR/maman-observer-$TRIPLE"
chmod +x "$DEST_DIR/maman-observer-$TRIPLE"
echo "build-observer: staged $DEST_DIR/maman-observer-$TRIPLE"
