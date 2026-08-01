#!/usr/bin/env bash
# Runs Rust test suites in the repository.
#
# Usage: scripts/test-rust.sh [browser-host|desktop ...]
#   No arguments runs every crate (the local/macOS default).
#
# The two crates have different platform needs, which is why they can be
# selected separately: `browser-host` is portable pure Rust, while `desktop`
# (Tauri) links the platform webview stack AND its build script requires the
# staged `maman-observer` sidecar for the host target triple — a Swift binary
# that only builds on macOS. Selecting `browser-host` lets Linux CI cover the
# portable crate without pretending it can build a macOS-only app.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HOME/.cargo/env" 2>/dev/null || true

declare -a SELECTED
if [[ $# -gt 0 ]]; then
  SELECTED=("$@")
else
  SELECTED=(browser-host desktop)
fi

manifest_for() {
  case "$1" in
    browser-host) echo "$ROOT_DIR/native/browser-host/Cargo.toml" ;;
    desktop) echo "$ROOT_DIR/apps/desktop/src-tauri/Cargo.toml" ;;
    *) echo "unknown crate: $1" >&2; return 1 ;;
  esac
}

FOUND=0
for crate in "${SELECTED[@]}"; do
  manifest="$(manifest_for "$crate")"
  if [[ -f "$manifest" ]]; then
    FOUND=1
    echo "== cargo test: $manifest"
    cargo test --manifest-path "$manifest"
  fi
done
if [[ "$FOUND" == "0" ]]; then
  echo "no Rust crates present yet"
fi
