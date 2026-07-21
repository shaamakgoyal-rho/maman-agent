#!/usr/bin/env bash
# Creates .env from .env.example and generates strong local-only secrets.
# Never overwrites an existing .env without explicit confirmation (FORCE_ENV_OVERWRITE=1).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "error: .env.example not found at $EXAMPLE_FILE" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" && "${FORCE_ENV_OVERWRITE:-0}" != "1" ]]; then
  echo ".env already exists. Refusing to overwrite."
  echo "Re-run with FORCE_ENV_OVERWRITE=1 to replace it (a backup will be created)."
  exit 0
fi

if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$ENV_FILE.backup.$(date +%s)"
  echo "Backed up existing .env"
fi

gen_secret() {
  # 32 random bytes, base64url without padding — safe for env files.
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
}

POSTGRES_PASSWORD="$(gen_secret)"
DEVICE_TOKEN_SIGNING_SECRET="$(gen_secret)"
OAUTH_STATE_SIGNING_SECRET="$(gen_secret)"
CONNECTOR_ENCRYPTION_MASTER_KEY="$(gen_secret)"
MINIO_ROOT_PASSWORD="$(gen_secret)"
DATABASE_URL="postgres://maman:${POSTGRES_PASSWORD}@localhost:5432/maman"

cp "$EXAMPLE_FILE" "$ENV_FILE"

set_var() {
  local key="$1" value="$2"
  # portable in-place sed (macOS + GNU)
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  fi
}

set_var "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
set_var "DATABASE_URL" "$DATABASE_URL"
set_var "DEVICE_TOKEN_SIGNING_SECRET" "$DEVICE_TOKEN_SIGNING_SECRET"
set_var "OAUTH_STATE_SIGNING_SECRET" "$OAUTH_STATE_SIGNING_SECRET"
set_var "CONNECTOR_ENCRYPTION_MASTER_KEY" "$CONNECTOR_ENCRYPTION_MASTER_KEY"
set_var "MINIO_ROOT_PASSWORD" "$MINIO_ROOT_PASSWORD"

chmod 600 "$ENV_FILE"
echo "Created .env with generated local-only secrets."
echo ""
echo "This .env runs Maman fully in DEMO mode (no API key, no external calls)."
echo "To go live with real Anthropic + Salesforce, edit exactly four values (see docs/GO_LIVE.md):"
echo "  1. MODEL_PROVIDER=anthropic"
echo "  2. ANTHROPIC_API_KEY=sk-ant-..."
echo "  3. CONNECTOR_MODE=real"
echo "  4. SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET / SALESFORCE_REDIRECT_URI"
echo "Env validation fails fast if any pair is half-set."
echo ""
echo "Next: pnpm infra:up"
