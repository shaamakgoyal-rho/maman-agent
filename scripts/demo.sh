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

# Milestone gates append real steps here as they land:
#   M1: migrate + seed
#   M2+: start API, web, worker, desktop
DEMO_READY=0
if [[ "$DEMO_READY" != "1" ]]; then
  echo ""
  echo "Infrastructure is up (Postgres, Redis, Temporal, Temporal UI :8233, MinIO :9001, Mailpit :8025)."
  echo "The application demo is not wired yet — this script gains migrate/seed and app"
  echo "startup as Milestones 1+ land. See BUILD_STATUS.md for current progress."
  exit 0
fi
