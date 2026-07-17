# Maman (maman-agent) — agent working instructions

Maman is a macOS desktop pet that observes permitted workflows, detects repeated work,
and compiles safe, policy-checked helper agents with shadow runs, human approvals, and
verified ROI. The full build specification lives in the original build spec; the
distilled rules below are binding for all code in this repository.

## Non-negotiable safety rules

- Never capture keystrokes, passwords, auth fields, payment fields, private-browsing
  content, password-manager content, or raw screen recordings by default.
- Never weaken authorization, tenant isolation, redaction, approval checks, or audit
  logging to make a test pass.
- LLM output is untrusted data: parse against strict Zod schemas, policy-check, and
  reject safely. The LLM may never change eligibility, risk, permissions, or value.
- Raw captured pixels never cross the device boundary. Raw typed input is never collected.
- Secret material never enters logs, analytics, prompts, or AgentSpec.
- Cross-tenant resources return 404 (never 403). Every repository call requires TenantContext.
- Deterministic logic for security, policy, cost, and workflow execution. LLM only for
  semantic naming, summarization, and constrained AgentSpec generation.

## Architecture

Five processes: Tauri desktop app, Swift observer sidecar (no network code), Chrome MV3
extension, Fastify API + Next.js admin, Temporal worker. See ARCHITECTURE.md.

Package boundaries (lint-enforced — packages must not import from apps):

- `packages/contracts` — all cross-process Zod schemas and types
- `packages/db` — Drizzle schema, migrations, tenant-scoped repositories
- `packages/pattern-engine`, `packages/policy-engine`, `packages/roi-engine` — pure,
  deterministic TypeScript; no UI/network/DB imports; policy-engine must never call an LLM
- `packages/agent-runtime` — AgentSpec validation + Temporal workflow definitions
- `packages/capability-catalog` — capability metadata and adapter interfaces
- `packages/model-provider` — Anthropic + deterministic demo implementations
- `packages/config` — product identity, design tokens, env validation

## Conventions

- Node >= 24, pnpm workspaces, Turborepo. Internal packages export TypeScript source
  directly (`"exports": { ".": "./src/index.ts" }`); apps bundle themselves.
- TypeScript strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noImplicitOverride.
- Wire/persisted formats: snake_case, UUID v7, ISO 8601 UTC, schema_version integers.
- All product names/colors come from `@maman/config` — never hardcode.
- Model names come from configuration, not source.

## Commands

- `pnpm demo` — full local demo (Docker Compose + seed + all services)
- `pnpm lint / typecheck / test / build` — turbo across the workspace
- `pnpm test:rust`, `pnpm test:swift` — native suites
- `bash scripts/bootstrap-local-env.sh` — create .env with generated local secrets

## Process

- Work milestone by milestone; keep BUILD_STATUS.md current with evidence (no marketing language).
- After every milestone: format, typecheck, unit + integration tests, build. Fix before continuing.
- Never commit certificates, profiles, or secrets. `.env` is ignored.
