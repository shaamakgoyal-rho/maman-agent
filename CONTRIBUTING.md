# Contributing to maman-agent

## Prerequisites

- macOS 14+ (full desktop build) or Linux (API/web/worker only)
- Node.js >= 24, pnpm 9, Docker Desktop, Rust stable, Xcode command-line tools (macOS)

## Getting started

```bash
pnpm install
bash scripts/bootstrap-local-env.sh
pnpm infra:up
pnpm demo
```

## Quality bar

Every change must pass before merge:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Rules that are never negotiable

- No keystroke capture paths, ever.
- No weakening of authorization, tenant isolation, redaction, approvals, or audit logging.
- No secrets in code, logs, prompts, or fixtures.
- Deterministic logic for security, policy, cost, and execution decisions.
- Packages must not import from apps (lint-enforced).

## Architecture decisions

Record significant decisions as ADRs in `docs/adr/` using the template
`docs/adr/0000-adr-template.md`.
