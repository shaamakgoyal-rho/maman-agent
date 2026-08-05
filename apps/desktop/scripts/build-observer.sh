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

# UNIVERSAL=1 stages a fat arm64 + x86_64 sidecar under the
# universal-apple-darwin triple, which is the name that
# `tauri build --target universal-apple-darwin` looks for. Without it an Intel Mac
# cannot run the observer at all: the app launches and silently never observes.
#
# `swift build --arch arm64 --arch x86_64` needs FULL Xcode (xcbuild). This builds
# each slice separately with -Xswiftc -target and lipos them, so it works with
# Command Line Tools only — the same constraint that makes XCTest unavailable here.
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  ARM_SCRATCH="$OBSERVER_DIR/.build"
  X86_SCRATCH="$OBSERVER_DIR/.build-x86"
  echo "build-observer: swift build (arm64 slice)"
  ( cd "$OBSERVER_DIR" && swift build -c release --product maman-observer )
  echo "build-observer: swift build (x86_64 slice, cross-compiled)"
  ( cd "$OBSERVER_DIR" && swift build -c release --product maman-observer \
      --scratch-path .build-x86 -Xswiftc -target -Xswiftc x86_64-apple-macos14.0 )

  ARM_BIN="$ARM_SCRATCH/release/maman-observer"
  X86_BIN="$X86_SCRATCH/release/maman-observer"
  for b in "$ARM_BIN" "$X86_BIN"; do
    [[ -f "$b" ]] || { echo "build-observer: missing slice $b" >&2; exit 1; }
  done

  # THREE names are required, not one. `tauri build --target
  # universal-apple-darwin` compiles each architecture as its own sub-build, and
  # each sub-build validates the sidecar for ITS OWN triple before lipo-ing the
  # Rust binary. Staging only the universal name fails with
  # "resource path binaries/maman-observer-x86_64-apple-darwin doesn't exist".
  cp "$ARM_BIN" "$DEST_DIR/maman-observer-aarch64-apple-darwin"
  cp "$X86_BIN" "$DEST_DIR/maman-observer-x86_64-apple-darwin"
  OUT="$DEST_DIR/maman-observer-universal-apple-darwin"
  lipo -create -output "$OUT" "$ARM_BIN" "$X86_BIN"
  chmod +x "$DEST_DIR/maman-observer-aarch64-apple-darwin" \
    "$DEST_DIR/maman-observer-x86_64-apple-darwin" "$OUT"
  UARCHS="$(lipo -archs "$OUT")"
  case "$UARCHS" in
    *arm64*x86_64* | *x86_64*arm64*) : ;;
    *) echo "build-observer: expected a fat binary, got: $UARCHS" >&2; exit 1 ;;
  esac
  echo "build-observer: staged per-arch + universal sidecars ($UARCHS)"
  exit 0
fi

echo "build-observer: swift build -c release (native/macos-observer)"
( cd "$OBSERVER_DIR" && swift build -c release --product maman-observer )
BIN="$OBSERVER_DIR/.build/release/maman-observer"
[[ -f "$BIN" ]] || { echo "build-observer: binary not produced at $BIN" >&2; exit 1; }

cp "$BIN" "$DEST_DIR/maman-observer-$TRIPLE"
chmod +x "$DEST_DIR/maman-observer-$TRIPLE"
echo "build-observer: staged $DEST_DIR/maman-observer-$TRIPLE"
