# Architecture

> This document grows with the build. Sections marked _(lands at Mn)_ are completed at
> that milestone; nothing here describes behavior that does not exist in the repository.

## Processes

| Process                        | Location                | Role                                                        |
| ------------------------------ | ----------------------- | ----------------------------------------------------------- |
| Desktop app (Tauri 2)          | `apps/desktop`          | Pet, consent, local encrypted store, local pattern analysis |
| macOS observer sidecar (Swift) | `native/macos-observer` | Semantic AX events; no network code                         |
| Chrome extension (MV3)         | `extensions/chrome`     | Semantic events from allowlisted sites                      |
| Native browser host (Rust)     | `native/browser-host`   | Authenticated bridge: extension → desktop                   |
| API (Fastify)                  | `apps/api`              | Tenant-isolated HTTP API                                    |
| Admin web (Next.js)            | `apps/web`              | Aggregate-only admin console + desktop auth pages           |
| Worker (Temporal)              | `apps/worker`           | Durable agent runs, capability adapters                     |

## Logical flow

```
pet + consent controls
  -> permissioned semantic observer
  -> local redaction + normalization
  -> encrypted local event store (SQLite + AES-256-GCM, key in Keychain)
  -> local episode + pattern engine (deterministic)
  -> redacted recommendation
  -> constrained AgentSpec compiler (LLM output = untrusted, schema-validated)
  -> deterministic policy engine
  -> shadow / supervised Temporal workflow
  -> capability adapters (demo or real)
  -> audit + ROI ledger
```

## Trust boundaries

- Webview is untrusted relative to the Tauri Rust core.
- Browser page is untrusted relative to the extension service worker.
- Extension is untrusted relative to the native messaging host.
- LLM output and connector responses are untrusted data.
- Org admins are not authorized to view personal raw events.
- Raw pixels never cross the device boundary; raw typed input is never collected.
- Secret material never enters logs, analytics, prompts, or AgentSpec.

## Data placement

**Device only:** normalized workflow events, episode details, private app names,
in-memory Teach Mode frames, observation settings, deletion history, the local
encryption key (macOS Keychain).

**Server:** org/membership metadata, opt-in redacted pattern summaries, synced
recommendations, AgentSpecs + immutable versions, connector metadata + envelope-encrypted
tokens, runs/approvals/steps/audit/ROI, aggregate analytics. Never raw screenshots.

## Package dependency map _(lands at M1)_

## AgentSpec lifecycle _(lands at M6)_

## Temporal execution sequence _(lands at M7)_

## Failure behavior _(lands at M10)_
