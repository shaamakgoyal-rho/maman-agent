#!/usr/bin/env bash
# Runs the Swift observer test suite (macOS only).
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "swift tests require macOS — skipping"
  exit 0
fi

PKG="$ROOT_DIR/native/macos-observer"
if [[ -f "$PKG/Package.swift" ]]; then
  if xcrun --find xctest >/dev/null 2>&1; then
    echo "== swift test: $PKG"
    (cd "$PKG" && swift test)
  else
    # Command Line Tools only (no XCTest): run the mirrored assertion runner.
    echo "== swift run ObserverCoreTestRunner (XCTest unavailable): $PKG"
    (cd "$PKG" && swift run ObserverCoreTestRunner)
  fi
else
  echo "no Swift package present yet"
fi
