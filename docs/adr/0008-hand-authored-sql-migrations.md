# ADR-0008: Hand-authored up/down SQL migrations; Drizzle for typed queries only

- Status: accepted
- Date: 2026-07-17
- Deciders: product engineering

## Context

The build gate requires migrations tested **up and down** on an empty database.
The schema needs RLS policies, FORCE RLS, append-only triggers, and partial
unique indexes — DDL that drizzle-kit cannot fully generate, and drizzle-kit
produces no down migrations.

## Decision

- Migrations are hand-authored SQL pairs (`NNNN_name.up.sql` / `NNNN_name.down.sql`)
  applied by a small deterministic migrator (`packages/db/src/migrator.ts`), each in
  its own transaction, tracked in `schema_migrations`.
- Drizzle ORM remains the query layer: `packages/db/src/schema.ts` mirrors the SQL
  for typed repositories. The integration suite migrates a fresh container and
  exercises the repositories, so schema drift fails tests.

## Consequences

- Full control over security-critical DDL; reversibility is tested, not assumed.
- Two representations of the schema exist; tests are the sync mechanism.

## Alternatives considered

- drizzle-kit generate/push: rejected — no down migrations, incomplete DDL coverage.
- Raw SQL everywhere (no ORM): rejected — the spec locks Drizzle and typed queries
  prevent a class of column/name bugs.
