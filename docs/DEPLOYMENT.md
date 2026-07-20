# Hosted deployment

What is live, where, and how to reproduce it. No secrets live in this file.

## 1. Shareable demo — Vercel (client-side, no backend)

The desktop app's browser build is deployed as a static site. It runs the
entire pet + workflow-detection + shadow/supervised-run + diff-approval + ROI-
receipt loop **client-side** with deterministic demo adapters — no API, no
database, nothing captured.

- **URL:** https://maman-demo.vercel.app
  - `/` — framed landing page
  - `/pet.html` — the pixel-art pet
  - `/panel.html` — the full app (onboarding → run demo workflow → suggestions →
    create agent → run supervised → approve → receipt)
  - `/lab.html` — Pet Lab (all animation states + demo sequence)
- **Team:** `shaamakgoyal-rho`
- **Reproduce:** `bash scripts/deploy-web-demo.sh`

## 2. Backend database — Supabase Postgres (real, hosted)

The full Maman schema is applied to the existing (previously empty) Supabase
project, with row-level security, the tamper-evident audit chain, append-only
receipts, and seeded demo data.

- **Project ref:** `avepgifjsesviubjoczw` (region us-west-2, Postgres 17)
- **Schema:** migrations `0000`–`0005` applied (all tenant tables have
  `ENABLE`+`FORCE` RLS; `SET LOCAL ROLE maman_app` verified working on Supabase
  via `GRANT maman_app TO postgres`).
- **Seed:** 1 org (`Acme Sales Demo`), 6 users, 6 completed supervised runs, 6
  verified ROI measurements. The admin-overview aggregate returns, over the
  hosted DB through the real `withTenant`/`adminOverview` code path:
  `6 active seats · cohort 6 · 1.70 verified hours · $127.02 net value`, and a
  cross-tenant query sees 0 rows (RLS enforced).
- **App connection role:** a dedicated `maman_api` LOGIN role (member of
  `maman_app`) was created so the app never needs the project's `postgres`
  password. Connect via the **transaction pooler** (serverless-safe):

  ```
  DATABASE_URL="postgresql://maman_api.avepgifjsesviubjoczw:<MAMAN_API_PW>@aws-1-us-west-2.pooler.supabase.com:6543/postgres"
  ```

  `createDbClient` auto-disables prepared statements for `:6543` pooler URLs
  (transaction pooling does not support them). The `<MAMAN_API_PW>` value is a
  secret held out of the repo (provided separately).

## 3. API server — why it is NOT on Vercel (by design)

The Fastify API is intentionally not deployable to Vercel serverless for a
credential-free demo, because the app's own security rules forbid it:

1. `buildServer` **throws** if `AUTH_MODE=dev` while `NODE_ENV=production` — and
   Vercel forces `NODE_ENV=production`. (Non-negotiable: dev auth is refused in
   production.)
2. `AUTH_MODE=workos` **requires** real `WORKOS_API_KEY` + `WORKOS_CLIENT_ID`
   (env validation fails otherwise).
3. The Temporal worker (durable runs) is a persistent process and cannot run on
   serverless at all; it needs a Temporal Cloud namespace.

So a public, credential-free API would require weakening a security guard —
which we do not do. This is the security model working as intended.

### Running the API against the hosted DB (verified)

On any long-running host (a VM, container, or locally), pointed at the hosted
Supabase Postgres:

```
export DATABASE_URL="postgresql://maman_api.avepgifjsesviubjoczw:<MAMAN_API_PW>@aws-1-us-west-2.pooler.supabase.com:6543/postgres"
export AUTH_MODE=dev NODE_ENV=development MODEL_PROVIDER=demo CONNECTOR_MODE=demo
export API_BASE_URL=http://localhost:4000 WEB_BASE_URL=http://localhost:3000
export REDIS_URL=redis://localhost:6379 TEMPORAL_ADDRESS=localhost:7233 TEMPORAL_NAMESPACE=default
export DEVICE_TOKEN_SIGNING_SECRET=$(openssl rand -hex 24)
export OAUTH_STATE_SIGNING_SECRET=$(openssl rand -hex 24)
export CONNECTOR_ENCRYPTION_MASTER_KEY=$(openssl rand -hex 24)
pnpm --filter @maman/api dev
# GET /health/ready → {"status":"ok","checks":{"database":"ok"}}
# GET /v1/admin/overview (x-dev-* headers) → the live aggregate above
```

For production, provide real WorkOS credentials (`AUTH_MODE=workos`), deploy the
API + Temporal worker to a long-running host, and a Temporal Cloud namespace.
