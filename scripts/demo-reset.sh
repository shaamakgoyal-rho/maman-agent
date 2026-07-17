#!/usr/bin/env bash
# Resets ONLY this project's Docker volumes and generated demo state.
# Requires explicit project-scoped confirmation. Never touches unrelated Docker resources.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "This will remove the maman-agent Docker Compose stack and its named volumes:"
echo "  - maman-agent_maman_postgres_data"
echo "  - maman-agent_maman_minio_data"
echo "It does NOT touch any other Docker containers, images, or volumes."

if [[ "${CONFIRM_DEMO_RESET:-}" != "maman-agent" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Type the project name (maman-agent) to confirm: " answer
    if [[ "$answer" != "maman-agent" ]]; then
      echo "confirmation failed — nothing was changed"
      exit 1
    fi
  else
    echo "Non-interactive shell: set CONFIRM_DEMO_RESET=maman-agent to confirm."
    exit 1
  fi
fi

docker compose down --volumes --remove-orphans
echo "project stack and volumes removed"
