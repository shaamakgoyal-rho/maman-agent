#!/usr/bin/env bash
# Secret scan over the working tree. Uses gitleaks when available; otherwise a
# conservative grep-based fallback so CI and pre-commit always have coverage.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source . --no-banner --redact
  echo "gitleaks: no secrets detected"
  exit 0
fi

echo "gitleaks not installed — running grep-based fallback scan"
PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk_live_[A-Za-z0-9]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  '-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----'
  'ghp_[A-Za-z0-9]{36}'
)
FOUND=0
for p in "${PATTERNS[@]}"; do
  if grep -rInE --exclude-dir={node_modules,.git,.turbo,dist,build,.next,target,coverage} "$p" . >/dev/null 2>&1; then
    echo "potential secret matching pattern: $p"
    grep -rInE --exclude-dir={node_modules,.git,.turbo,dist,build,.next,target,coverage} "$p" . | head -5
    FOUND=1
  fi
done
if [[ "$FOUND" == "1" ]]; then
  echo "secret scan FAILED" >&2
  exit 1
fi
echo "secret scan passed (fallback mode)"
