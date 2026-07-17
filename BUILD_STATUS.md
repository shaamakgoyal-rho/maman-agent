# BUILD_STATUS

Status ledger for the Maman production-shaped v1 build. One row per milestone.
Evidence must be exact (commands run, test counts). No marketing language.

| Milestone                                | Status      | Evidence                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 Repository foundation                 | complete    | `pnpm install` (pnpm 9.15.9, Node 26), `pnpm lint` 2/2, `pnpm typecheck` 2/2, `pnpm test` 8/8 unit tests pass, `pnpm build` runs; `docker compose up -d --wait`: postgres/redis/temporal/temporal-ui/minio/mailpit all healthy |
| M1 Contracts, DB, auth, tenant isolation | in_progress | —                                                                                                                                                                                                                              |
| M2 Desktop shell and pet                 | pending     | —                                                                                                                                                                                                                              |
| M3 Local encrypted event pipeline        | pending     | —                                                                                                                                                                                                                              |
| M4 macOS observer + Chrome extension     | pending     | —                                                                                                                                                                                                                              |
| M5 Pattern + recommendation engine       | pending     | —                                                                                                                                                                                                                              |
| M6 Agent compiler + policy engine        | pending     | —                                                                                                                                                                                                                              |
| M7 Durable runs + demo capabilities      | pending     | —                                                                                                                                                                                                                              |
| M8 Real connectors                       | pending     | —                                                                                                                                                                                                                              |
| M9 ROI + admin                           | pending     | —                                                                                                                                                                                                                              |
| M10 Hardening + handoff                  | pending     | —                                                                                                                                                                                                                              |

## Known limitations

- No application logic yet (by design at M0). `pnpm demo` starts infrastructure only and
  says so explicitly.
- Temporal pinned to auto-setup 1.25.2; UI 2.31.2.

## Next milestone

M1: contracts package, Drizzle schema + migrations, dev auth + WorkOS adapter, tenant
repositories + RLS, audit hash chain, OpenAPI base.
