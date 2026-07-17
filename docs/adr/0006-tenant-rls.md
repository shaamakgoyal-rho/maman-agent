# ADR-0006: Double-walled tenant isolation — TenantContext plus PostgreSQL RLS

- Status: accepted
- Date: 2026-07-17
- Deciders: product engineering

## Context

Every server-side resource is scoped by organization_id, and a cross-tenant leak
is a company-ending event for a product that observes employee workflows.
Application-level WHERE clauses alone are one forgotten filter away from a breach.

## Decision

Two independent walls:

1. **Application:** every repository function requires a `TenantContext`; personal
   resources additionally filter by `owner_user_id`.
2. **Database:** every tenant table has `ROW LEVEL SECURITY` + `FORCE` and a policy
   comparing `organization_id` to `current_setting('app.organization_id', true)::uuid`.
   `withTenant()` opens a transaction, applies `set_config(app.organization_id, …)`,
   and drops to the non-owner `maman_app` role via `SET LOCAL ROLE` — otherwise a
   superuser/owner connection would silently bypass RLS.

Cross-tenant lookups return 404 (never 403) at the API so resource existence is
not disclosed.

## Consequences

- A forgotten WHERE clause returns zero foreign rows instead of leaking
  (proven by unfiltered-SELECT probes in the integration suite for all 17 tenant tables).
- Migrations run privileged; tenant queries run restricted — one connection pool.
- Every tenant query pays a transaction; acceptable at pilot scale, and batching
  stays available inside `withTenant`.

## Alternatives considered

- Application filters only: rejected — no defense in depth.
- Database-per-tenant: rejected — operational overkill for v1.
- Separate login role for the app: equivalent isolation but complicates local and
  Testcontainers setup versus `SET LOCAL ROLE`.
