#!/usr/bin/env bash
# Deploy the client-side desktop demo (pet + panel + full run loop) to Vercel
# as a static site. No backend required — it runs entirely in the browser.
#
# Usage: bash scripts/deploy-web-demo.sh [--prod]
#   Requires the `vercel` CLI, logged in. Defaults to a preview deployment.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERCEL_SCOPE="${VERCEL_SCOPE:-shaamakgoyal-rho}"
TARGET_FLAG=""
[[ "${1:-}" == "--prod" ]] && TARGET_FLAG="--prod"

echo "== building the desktop browser bundle"
pnpm --filter @maman/desktop build

STAGE="$(mktemp -d)/maman-demo"
mkdir -p "$STAGE"
cp -R "$ROOT_DIR/apps/desktop/dist/." "$STAGE/"
# The built panel is index.html; move it under /panel.html and use the framed
# landing page as the root (asset paths are absolute, so this is safe).
mv "$STAGE/index.html" "$STAGE/panel.html"
cp "$ROOT_DIR/deploy/web-demo/index.html" "$STAGE/index.html"
cp "$ROOT_DIR/deploy/web-demo/vercel.json" "$STAGE/vercel.json"

echo "== deploying to Vercel (scope: $VERCEL_SCOPE)"
cd "$STAGE"
vercel deploy --yes --scope "$VERCEL_SCOPE" $TARGET_FLAG

echo "Done. Routes: / (landing) · /pet.html · /panel.html · /lab.html"
