# Maman operations runbook

Production-shaped v1. This runbook covers local demo, the server processes, and
the standard operational levers. It is deliberately concrete.

## Processes

| Process       | What it is                         | Entry / image                            |
| ------------- | ---------------------------------- | ---------------------------------------- |
| API           | Fastify HTTP API                   | `apps/api` — `apps/api/Dockerfile`       |
| Worker        | Temporal worker (durable runs)     | `apps/worker` — `apps/worker/Dockerfile` |
| Web           | Next.js admin console              | `apps/web` — `apps/web/Dockerfile`       |
| Desktop       | Tauri app + Swift observer sidecar | `pnpm --filter @maman/desktop tauri dev` |
| Browser Relay | Chrome MV3 extension (accessory)   | `extensions/chrome`                      |

Backing services (docker-compose): Postgres 17, Redis, Temporal + UI, MinIO,
Mailpit.

## Local demo

```
pnpm demo
```

Starts infrastructure, migrates, seeds the demo org (6 users + verified ROI),
then starts API, worker, and the admin console and prints every URL. The desktop
pet runs separately (`pnpm --filter @maman/desktop tauri dev` on macOS, or the
Vite preview elsewhere). Everything runs credential-free in demo mode.

## Database

- Migrate: `pnpm db:migrate` (hand-authored up/down SQL; forward-only in prod).
- Reseed demo only: `CONFIRM_DEMO_RESET=maman-agent pnpm db:reset-demo`.
- Roll back one migration: `pnpm db:rollback` (applies the paired `.down.sql`).
- Every tenant table has RLS with FORCE; the app connects as the NOLOGIN
  `maman_app` role via `SET LOCAL ROLE` inside `withTenant`. Never run the app as
  a superuser — superusers bypass RLS.

## Operational levers

### Kill switch (stop everything for one org)

`POST /v1/admin/kill-switch` (any member for their own org). Pauses every
non-retired agent and cancels queued/running/waiting runs in one transaction, and
writes a tamper-evident audit event. Idempotent. Use when a connector, policy, or
data-quality problem is suspected. Re-enable agents individually afterward.

### Disconnect a connector

`POST /v1/connectors/:provider/disconnect`. Revokes the connector and pauses
every agent whose spec depends on that provider. Tokens are destroyed
server-side; nothing to clean up on client machines.

### Pause observation (per user)

In the desktop app: Privacy → pause, or the global shortcut. Observation is
opt-in per app/domain and never captures keystrokes, passwords, auth/payment
fields, private-browsing, or password-manager content.

## Data retention

See `docs/RETENTION.md`. Summary: raw local events are encrypted at rest on the
device and never leave it in raw form; only redacted, boundary-checked features
sync. Deletion (per event / per app / all) writes tombstones that survive
retention sweeps. Audit and receipt tables are append-only and are retained for
the organization's configured window (default 400 days), never mutated.

## Verifying integrity

- Audit chain: `verifyAuditChain(sql, ctx)` detects any mutation, reorder, or
  deletion in an org's hash-linked audit log.
- Migrations: CI runs up → down → up on an empty PG17 and checks OpenAPI drift.
- Security invariants: `apps/api` integration suite proves cross-tenant reads
  return 404 (never 403), connector tokens never appear in any client response,
  and dev auth mode cannot be constructed under `NODE_ENV=production`.

## Incident quick reference

| Symptom                        | First action                                                          |
| ------------------------------ | --------------------------------------------------------------------- |
| Suspect an agent misbehaving   | Kill switch for the org, then inspect receipts                        |
| Connector returning bad writes | Disconnect the connector (auto-pauses agents)                         |
| Suspected data exposure        | Kill switch + rotate `CONNECTOR_ENCRYPTION_MASTER_KEY`                |
| Worker backed up               | Check Temporal UI (:8233); workers scale horizontally                 |
| "Value looks wrong"            | Read the receipt — ROI carries measured/inferred/estimated provenance |
