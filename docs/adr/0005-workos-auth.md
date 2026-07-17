# ADR-0005: WorkOS AuthKit for production identity, header-based dev auth locally

- Status: accepted
- Date: 2026-07-17
- Deciders: product engineering

## Context

Maman is B2B: organizations, memberships, and roles are first-class. Production
needs SSO-capable, org-aware authentication without building an identity stack.
Local development and CI must run the full product with zero external credentials.

## Decision

- Production authenticates through WorkOS AuthKit (users + organizations). The API
  verifies bearer tokens through a `WorkosTokenVerifier` / `WorkosIdentityResolver`
  adapter pair (`apps/api/src/auth.ts`).
- Local development uses `AUTH_MODE=dev`: identity headers (`x-dev-user-id`,
  `x-dev-org-id`, `x-dev-role`) parsed against the Principal schema.
- `AUTH_MODE=dev` with `NODE_ENV=production` is refused twice: at env validation
  (`packages/config/src/env.ts`) and at server construction (`buildServer`).
- Roles are `member | manager | org_admin | security_admin | billing_admin`; every
  handler calls the centralized `authorize()` — no inline role checks in routes.

## Consequences

- The dev path exercises the same Principal contract as production.
- WorkOS webhooks/directory sync integrate later without contract changes.
- An unconfigured WorkOS verifier rejects every token — fail closed.

## Alternatives considered

- Auth0/Clerk: viable, but WorkOS is locked by the build spec and purpose-built
  for B2B organizations.
- Homegrown JWT auth: rejected — undifferentiated security-critical work.
