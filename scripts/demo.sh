#!/usr/bin/env bash
# One-command local demo. Every step it performs is real.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "== .env missing — bootstrapping local environment"
  bash scripts/bootstrap-local-env.sh
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "== starting local infrastructure (Docker Compose)"
docker compose up -d --wait

echo "== migrating database"
pnpm db:migrate

echo "== seeding demo organization (6 identities + verified ROI)"
pnpm db:seed

LOG_DIR="${TMPDIR:-/tmp}/maman-demo"
mkdir -p "$LOG_DIR"

echo "== starting API (:4000)"
(cd apps/api && pnpm dev >"$LOG_DIR/api.log" 2>&1 &)

echo "== starting Temporal worker"
(cd apps/worker && pnpm dev >"$LOG_DIR/worker.log" 2>&1 &)

echo "== starting admin web console (:3000)"
(cd apps/web && API_BASE_URL="${API_BASE_URL:-http://localhost:4000}" pnpm dev >"$LOG_DIR/web.log" 2>&1 &)

# Wait for API readiness.
echo "== waiting for API health"
for i in $(seq 1 30); do
  if curl -sf http://localhost:4000/health/ready >/dev/null 2>&1; then
    echo "API ready"
    break
  fi
  sleep 1
done

echo ""
echo "Maman demo is up:"
echo "  • Admin console:   http://localhost:3000  (Acme Sales Demo — 6 users, aggregate ROI)"
echo "  • API:             http://localhost:4000  (health at /health/ready)"
echo "  • Temporal UI:     http://localhost:8233"
echo "  • MinIO console:   http://localhost:9001"
echo "  • Mailpit:         http://localhost:8025"
echo "  • Logs:            $LOG_DIR"
echo ""
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Desktop pet: pnpm --filter @maman/desktop tauri dev"
else
  echo "Desktop preview (non-macOS): pnpm --filter @maman/desktop dev  (open /pet.html, /, /lab.html)"
fi
echo ""
echo "In the desktop panel: complete onboarding → Run demo workflow → Suggestions →"
echo "Create agent → Agents → Run supervised → approve the diff → see the receipt."
echo ""
echo "Stop everything: pnpm infra:down  (and Ctrl-C / kill the node processes in $LOG_DIR)"
