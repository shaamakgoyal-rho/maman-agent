#!/usr/bin/env bash
# Produces a license report for all workspace dependencies.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p reports
pnpm licenses list --json > reports/licenses.json
COUNT=$(node -e "const d=require('./reports/licenses.json');console.log(Object.keys(d).length)")
echo "license report written to reports/licenses.json (${COUNT} license families)"

# Fail on strong-copyleft licenses that are incompatible with a proprietary product.
node -e "
const data = require('./reports/licenses.json');
const banned = ['GPL-2.0-only','GPL-3.0-only','AGPL-3.0-only','AGPL-3.0-or-later','GPL-2.0','GPL-3.0','AGPL-3.0'];
const hits = Object.keys(data).filter((l) => banned.includes(l));
if (hits.length) { console.error('banned licenses found:', hits.join(', ')); process.exit(1); }
console.log('no banned licenses');
"
