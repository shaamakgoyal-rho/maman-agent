#!/usr/bin/env bash
# CI guard: the macOS observer must contain NO networking code and NO
# keystroke path. Scans source imports and the dependency graph.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT_DIR/native/macos-observer"
FAIL=0

echo "== scanning observer sources for networking frameworks"
if grep -rnE "import (Network|NIO|URLSession)|URLSession|NWConnection|CFSocket|socket\(" \
    "$PKG/Sources" 2>/dev/null; then
  echo "FAIL: networking symbol found in observer sources" >&2
  FAIL=1
fi

echo "== scanning observer sources for keystroke APIs"
if grep -rnE "CGEventTap|addGlobalMonitorForEvents|addLocalMonitorForEvents|keyDown|keyUp|kCGEventKeyDown" \
    "$PKG/Sources" 2>/dev/null; then
  echo "FAIL: keystroke API found in observer sources" >&2
  FAIL=1
fi

echo "== scanning dependency graph"
if [[ -f "$PKG/Package.resolved" ]]; then
  if grep -iE "nio|network|alamofire|urlsession" "$PKG/Package.resolved"; then
    echo "FAIL: networking dependency in Package.resolved" >&2
    FAIL=1
  fi
else
  # No resolved file means zero external dependencies — the strongest state.
  DEPS=$(grep -c "\.package(" "$PKG/Package.swift" || true)
  if [[ "${DEPS}" != "0" ]]; then
    echo "FAIL: Package.swift declares dependencies but Package.resolved missing" >&2
    FAIL=1
  fi
  echo "no external dependencies declared"
fi

if [[ "$FAIL" == "0" ]]; then
  echo "observer no-network / no-keystroke scan passed"
else
  exit 1
fi
