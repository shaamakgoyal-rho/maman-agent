#!/usr/bin/env bash
# Runs every Rust test suite in the repository.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HOME/.cargo/env" 2>/dev/null || true

FOUND=0
for manifest in "$ROOT_DIR"/native/browser-host/Cargo.toml "$ROOT_DIR"/apps/desktop/src-tauri/Cargo.toml; do
  if [[ -f "$manifest" ]]; then
    FOUND=1
    echo "== cargo test: $manifest"
    cargo test --manifest-path "$manifest"
  fi
done
if [[ "$FOUND" == "0" ]]; then
  echo "no Rust crates present yet"
fi
