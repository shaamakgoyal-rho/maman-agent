#!/usr/bin/env bash
# Builds the distributable Maman.dmg: a UNIVERSAL (arm64 + x86_64) app, signed
# with the stable dev identity, packaged as a drag-to-Applications disk image.
#
# Usage: bash scripts/build-release-dmg.sh [output.dmg]
#   Default output: dist/Maman.dmg
#
# WHY THIS SCRIPT EXISTS RATHER THAN `tauri build --bundles dmg`:
#
# 1. Tauri's own DMG step runs bundle_dmg.sh, which drives Finder over AppleScript
#    to lay out the window. That fails on a machine without Finder automation
#    permission (and in CI), taking the whole build down AFTER the .app succeeded.
#    `hdiutil` needs no AppleScript, so this is reproducible anywhere.
#    For the same reason `dmg` is deliberately NOT in tauri.conf bundle.targets:
#    it would break every ordinary `pnpm tauri build`.
#
# 2. The app must be signed with a real (if self-signed) identity, not ad-hoc.
#    Ad-hoc gives Gatekeeper "no usable signature", which shows the user the harsh
#    "Maman is damaged and can't be opened" — where right-click → Open does NOT
#    reliably work. Signed, it becomes "developer cannot be verified", where it
#    does. Same rejection either way until notarized; only the wording and the
#    user's escape hatch differ.
#
# NOT NOTARIZED. Every download will hit Gatekeeper. To fix that properly you need
# an Apple Developer ID, then: codesign --options runtime --sign "Developer ID
# Application: …", xcrun notarytool submit --wait, xcrun stapler staple. Those
# credentials are yours and are deliberately not referenced here.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT_DIR/dist/Maman.dmg}"
APP="$ROOT_DIR/apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Maman.app"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-release-dmg: macOS only" >&2
  exit 1
fi

echo "== 1/5 universal observer sidecar"
UNIVERSAL=1 bash "$ROOT_DIR/apps/desktop/scripts/build-observer.sh"
# The native-messaging host ships in the bundle too, so the app can install
# Chrome's manifest itself instead of a user running a build script.
UNIVERSAL=1 bash "$ROOT_DIR/apps/desktop/scripts/build-browser-host.sh"

echo "== 2/5 universal app bundle"
( cd "$ROOT_DIR/apps/desktop" && pnpm tauri build --target universal-apple-darwin )
[[ -d "$APP" ]] || { echo "build-release-dmg: no app at $APP" >&2; exit 1; }

echo "== 3/5 sign with the stable dev identity"
bash "$ROOT_DIR/scripts/dev-codesign.sh" "$APP" >/dev/null
codesign --verify --deep --strict "$APP"

echo "== 4/5 verify both binaries are fat before shipping"
for bin in maman-desktop maman-observer maman-browser-host; do
  archs="$(lipo -archs "$APP/Contents/MacOS/$bin")"
  case "$archs" in
    *arm64*x86_64* | *x86_64*arm64*) echo "   $bin: $archs" ;;
    *)
      # Shipping a thin binary silently excludes half of macOS, so refuse.
      echo "build-release-dmg: $bin is not universal ($archs)" >&2
      exit 1
      ;;
  esac
done

echo "== 5/5 package"
mkdir -p "$(dirname "$OUT")" "$STAGE/dmg"
ditto "$APP" "$STAGE/dmg/Maman.app"
ln -s /Applications "$STAGE/dmg/Applications"   # makes it a drag-install
rm -f "$OUT"
hdiutil create -volname "Maman" -srcfolder "$STAGE/dmg" -ov -format UDZO "$OUT" >/dev/null

SIZE="$(du -h "$OUT" | awk '{print $1}')"
echo ""
echo "wrote $OUT ($SIZE)"
shasum -a 256 "$OUT"
echo ""
echo "Gatekeeper verdict a downloader will get (expected: rejected until notarized):"
spctl -a -vvv "$APP" 2>&1 | sed 's/^/  /' || true
