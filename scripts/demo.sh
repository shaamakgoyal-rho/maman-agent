#!/usr/bin/env bash
# One-command local demo. Grows with each milestone; every step it performs is real.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "== .env missing — bootstrapping local environment"
  bash scripts/bootstrap-local-env.sh
fi

echo "== starting local infrastructure (Docker Compose)"
docker compose up -d --wait

echo "== migrating database"
pnpm db:migrate

echo "== seeding demo organization"
pnpm db:seed

# Milestone gates append real steps here as they land:
#   M2+: start API, web, worker, desktop
DEMO_READY=0
if [[ "$DEMO_READY" != "1" ]]; then
  echo ""
  echo "Infrastructure is up (Postgres, Redis, Temporal UI :8233, MinIO :9001, Mailpit :8025)."
  echo "Database migrated and seeded (Acme Sales Demo, 6 identities)."
  echo "App startup lands with Milestone 2+. See BUILD_STATUS.md for current progress."
  exit 0
fi
