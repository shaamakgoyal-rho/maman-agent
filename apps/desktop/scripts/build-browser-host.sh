#!/usr/bin/env bash
# Builds the Chrome native-messaging host and stages it for Tauri bundling.
#
# WHY THIS EXISTS. The host used to be installed only by
# scripts/install-native-host-macos.sh, which builds from a repo checkout with
# cargo — so a real user (no repo, no toolchain) could never reach the relay
# lane at all. Shipping the host INSIDE the app bundle is what makes the
# extension installable by a person instead of a developer: the app then writes
# Chrome's NativeMessagingHosts manifest pointing at its own bundled binary.
#
# Mirrors build-observer.sh: Tauri's `externalBin` wants
#   src-tauri/binaries/maman-browser-host-<target-triple>
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOST_DIR="$ROOT_DIR/native/browser-host"
DEST_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"
mkdir -p "$DEST_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "build-browser-host: cargo not found — skipping." >&2
  exit 0
fi

TRIPLE="$(rustc -vV 2>/dev/null | awk '/host:/ {print $2}')"
if [[ -z "$TRIPLE" ]]; then
  ARCH="$(uname -m)"; [[ "$ARCH" == "arm64" ]] && ARCH="aarch64"
  TRIPLE="${ARCH}-apple-darwin"
fi

# UNIVERSAL=1 stages per-arch AND fat binaries, for the same reason the
# observer does: `tauri build --target universal-apple-darwin` validates the
# sidecar for each sub-build's own triple before lipo-ing.
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  echo "build-browser-host: cargo build (aarch64 + x86_64)"
  ( cd "$HOST_DIR" && cargo build --release --target aarch64-apple-darwin )
  ( cd "$HOST_DIR" && cargo build --release --target x86_64-apple-darwin )
  ARM_BIN="$HOST_DIR/target/aarch64-apple-darwin/release/maman-browser-host"
  X86_BIN="$HOST_DIR/target/x86_64-apple-darwin/release/maman-browser-host"
  for b in "$ARM_BIN" "$X86_BIN"; do
    [[ -f "$b" ]] || { echo "build-browser-host: missing slice $b" >&2; exit 1; }
  done
  cp "$ARM_BIN" "$DEST_DIR/maman-browser-host-aarch64-apple-darwin"
  cp "$X86_BIN" "$DEST_DIR/maman-browser-host-x86_64-apple-darwin"
  OUT="$DEST_DIR/maman-browser-host-universal-apple-darwin"
  lipo -create -output "$OUT" "$ARM_BIN" "$X86_BIN"
  chmod +x "$DEST_DIR/maman-browser-host-aarch64-apple-darwin" \
    "$DEST_DIR/maman-browser-host-x86_64-apple-darwin" "$OUT"
  echo "build-browser-host: staged per-arch + universal ($(lipo -archs "$OUT"))"
  exit 0
fi

echo "build-browser-host: cargo build --release (native/browser-host)"
( cd "$HOST_DIR" && cargo build --release )
BIN="$HOST_DIR/target/release/maman-browser-host"
[[ -f "$BIN" ]] || { echo "build-browser-host: binary not produced at $BIN" >&2; exit 1; }
cp "$BIN" "$DEST_DIR/maman-browser-host-$TRIPLE"
chmod +x "$DEST_DIR/maman-browser-host-$TRIPLE"
echo "build-browser-host: staged $DEST_DIR/maman-browser-host-$TRIPLE"
