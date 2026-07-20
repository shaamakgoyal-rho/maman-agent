/**
 * API load test (k6) — gated, EXCLUDED from CI. Run against a running stack:
 *
 *   pnpm demo   # brings up the API + seeded demo org
 *   MAMAN_ORG_ID=<uuid> k6 run scripts/load-test.k6.js
 *
 * Resolve the demo org UUID with:
 *   curl -s "http://localhost:4000/v1/dev/resolve-org?workos_id=org_demo_acme_sales"
 *
 * Documented targets (v1, single API instance, local Postgres):
 *   - Steady load: 50 requests/second for 1 minute.
 *   - p95 latency < 300 ms.
 *   - Error rate < 1%.
 * These are starting SLOs to catch regressions, not a capacity claim; raise the
 * arrival rate to profile headroom on real infrastructure.
 */
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    steady: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], // < 1% errors
    http_req_duration: ["p(95)<300"], // p95 under 300ms
  },
};

const BASE = __ENV.MAMAN_API_BASE_URL || "http://localhost:4000";
const ORG = __ENV.MAMAN_ORG_ID || "";
const USER = __ENV.MAMAN_USER_ID || "00000000-0000-7000-8000-0000000000ad";

export default function () {
  // Unauthenticated readiness — always available.
  const health = http.get(`${BASE}/health/ready`);
  check(health, { "health ready 200": (r) => r.status === 200 });

  // Authenticated tenant-scoped aggregate (dev auth headers), when an org is set.
  if (ORG) {
    const overview = http.get(`${BASE}/v1/admin/overview`, {
      headers: {
        "x-dev-org-id": ORG,
        "x-dev-user-id": USER,
        "x-dev-role": "org_admin",
      },
    });
    check(overview, {
      "admin overview 200": (r) => r.status === 200,
      "overview is aggregate (no raw events)": (r) => !String(r.body).includes("event_id"),
    });
  }
  sleep(0.2);
}
